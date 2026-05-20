// AI quality scoring module.
//
// Scores each generated reply on a 1-10 scale BEFORE sending. This gives:
//   - A pre-send quality gate (optionally skip replies below a threshold)
//   - Historical quality data for growth analytics
//   - Correlation data: quality_score vs actual engagement
//
// The scoring is done via a second, cheap AI call using the same model.
// It's a single classification prompt — fast (<1s on gpt-4o-mini) and
// costs ~$0.00005 per call (~$0.05/day at 1000 replies).
//
// Scoring criteria (communicated to the model):
//   1-3: Generic, could be sent to any tweet. Spam-adjacent.
//   4-5: On-topic but forgettable. Won't get engagement.
//   6-7: Solid reply. Specific, shows understanding.
//   8-9: Excellent. Hook-worthy, likely to get likes/follows.
//   10:  Exceptional. Viral-quality insight or wit.
import { logger } from '../core/logger.js';

const REQUEST_TIMEOUT_MS = 10_000;
const SCORE_CACHE_TTL_MS = 60_000; // cache recent scores to avoid redundant calls

// Simple in-memory LRU to avoid double-scoring if runner retries
const _cache = new Map();
const CACHE_MAX = 100;

function readConfig() {
  return {
    key: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  };
}

/**
 * Score a reply's quality before sending.
 * Returns a number 1-10, or null if scoring is unavailable.
 */
export async function scoreReply({ replyText, tweetText, tweetAuthor, persona }) {
  const cfg = readConfig();
  if (!cfg.key) return null;

  // Check cache
  const cacheKey = `${replyText.slice(0, 100)}|${tweetText.slice(0, 100)}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SCORE_CACHE_TTL_MS) {
    return cached.score;
  }

  const system =
    `You are a reply quality scorer for X (Twitter). Rate the reply on a 1-10 scale.\n` +
    `Criteria:\n` +
    `1-3: Generic, could be sent to any tweet. Spam-adjacent. No specifics.\n` +
    `4-5: On-topic but forgettable. Safe, won't stand out.\n` +
    `6-7: Solid. Specific to the tweet, shows understanding, adds value.\n` +
    `8-9: Excellent. Has a hook — contrarian take, specific number, cliffhanger, or reframe.\n` +
    `10: Exceptional. Viral-quality insight, wit, or perspective shift.\n\n` +
    `Respond with ONLY a single integer 1-10. Nothing else.`;

  const user =
    `Tweet by @${tweetAuthor || 'unknown'}:\n"${tweetText}"\n\n` +
    `Reply:\n"${replyText}"\n\n` +
    (persona?.style ? `Persona voice: ${persona.style}\n` : '') +
    `Score (1-10):`;

  const ctrl = new AbortController();
  const tHandle = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${cfg.key}`,
        'content-type': 'application/json',
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.1, // Low temp for consistent scoring
        max_tokens: 5,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      logger.warn('quality', `scoring API error: HTTP ${resp.status} ${body.slice(0, 100)}`);
      return null;
    }

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();
    const score = parseInt(raw, 10);

    if (isNaN(score) || score < 1 || score > 10) {
      logger.warn('quality', `unexpected score response: "${raw}"`);
      return null;
    }

    // Cache it
    if (_cache.size >= CACHE_MAX) {
      const firstKey = _cache.keys().next().value;
      _cache.delete(firstKey);
    }
    _cache.set(cacheKey, { score, ts: Date.now() });

    return score;
  } catch (e) {
    if (e.name === 'AbortError') {
      logger.warn('quality', 'scoring request timed out');
    }
    return null;
  } finally {
    clearTimeout(tHandle);
  }
}

/**
 * Optional quality gate — returns true if the reply should be sent.
 * Default threshold: 5 (skip generic/forgettable replies to protect engagement rate).
 */
export function passesQualityGate(score, threshold = 5) {
  if (score === null) return true; // If scoring fails, don't block
  return score >= threshold;
}
