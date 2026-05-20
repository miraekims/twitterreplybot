// Auto-post drafting — generates 3 candidate top-level tweets from a
// topic seed, in the campaign's persona voice.
//
// v2 changes:
//   - Posts target 200-280 chars (full X limit) instead of the previous
//     ~115-char snippets. Longer posts get more engagement — the algo
//     rewards dwell time and replies, both of which correlate with
//     substantive content.
//   - Feed-aware: when the runner has been scanning HomeTimeline, we
//     sample recent high-engagement tweets and inject them as context.
//     The model sees what's trending in the user's niche and writes
//     posts that participate in the current conversation — not generic
//     takes disconnected from the timeline.
//   - The prompt structure now explicitly asks for 2-4 sentence posts
//     with a hook + substance + optional CTA pattern.
//
// Cost note: gpt-4o-mini at 3 candidates, ~150 tokens each ≈ $0.001 per
// /draft. Still cheap.

import { logger } from '../core/logger.js';
import { getRecentFeedSample } from '../campaign/runner.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_POST_CHARS = 280;
const TARGET_MIN_CHARS = 200;

function readConfig() {
  return {
    key: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  };
}

/**
 * Generate `count` candidate posts from a topic seed.
 *
 * @param {object} args
 * @param {string} args.topic   Free-form topic seed (e.g. "ETH ETF flows").
 * @param {object} [args.persona]  Same shape as persona.js expects.
 * @param {number} [args.count=3]  How many candidates to return.
 * @param {string} [args.link]  Optional URL to surface naturally.
 * @returns {Promise<string[]>}    Up to `count` plain-text candidates,
 *                                 deduped, 200-280 chars each.
 */
export async function generateDrafts({ topic, persona, count = 3, link = '' }) {
  const cfg = readConfig();
  if (!cfg.key) {
    throw new Error(
      'OPENAI_API_KEY not set. Auto-drafts need an LLM — ' +
      'set via /apikey or use /post <text> with your own copy.',
    );
  }
  if (!topic || !topic.trim()) {
    throw new Error('Topic is required. Try /draft <topic>, e.g. /draft eth gas trends.');
  }

  const system = buildPostSystemPrompt(persona);

  // Feed context: sample recent high-engagement tweets from the user's
  // timeline. This grounds the model in what's actually being discussed
  // RIGHT NOW — produces posts that participate in ongoing conversations
  // rather than generic filler.
  const feedSample = getRecentFeedSample(15);
  const feedContext = feedSample.length > 0
    ? '\n\n--- CURRENT FEED CONTEXT (what people in your niche are posting right now) ---\n' +
      feedSample.map((t, i) =>
        `${i + 1}. @${t.authorHandle}: "${t.text.slice(0, 200)}" (${t.favoriteCount} likes)`
      ).join('\n') +
      '\n--- END FEED CONTEXT ---\n\n' +
      'Use the feed context to understand what topics are hot RIGHT NOW. ' +
      'Your post should feel like a natural addition to this conversation — ' +
      'react to trends, add your angle, or build on what others are discussing. ' +
      'Do NOT quote or directly reply to any specific tweet above.'
    : '';

  const examples = (persona?.examples || []).slice(0, 8);
  const examplesBlock = examples.length
    ? '\n\nVoice samples (reply-shaped but the tone is the same):\n' +
      examples.map((ex, i) => `${i + 1}. ${ex.reply}`).join('\n')
    : '';

  const linkClause = link
    ? `\n\nOptional: include this link naturally if relevant: ${link}\n` +
      `Don't force it. If the post reads better without, drop it.`
    : '';

  const userPrompt =
    `Topic: ${topic.trim()}\n` +
    feedContext +
    `\nWrite ${count} different candidate posts (top-level tweets, NOT replies) ` +
    `on this topic in my voice.${linkClause}\n\n` +
    `CRITICAL length requirement:\n` +
    `- Each post MUST be ${TARGET_MIN_CHARS}-${MAX_POST_CHARS} characters (this is mandatory)\n` +
    `- Aim for 240-270 chars — use the FULL space X gives you\n` +
    `- Posts under 200 chars will be rejected — add more substance\n` +
    `- Structure: hook sentence + supporting detail/data/reasoning + optional question or CTA\n\n` +
    `Content requirements:\n` +
    `- Each must take a SPECIFIC angle or claim grounded in current discussion\n` +
    `- Reference real protocols, metrics, events, or mechanisms — not vague generalities\n` +
    `- No two candidates restate the same thesis with different words\n` +
    `- Make it feel like you JUST saw something in your feed that triggered this thought\n` +
    `- Don't open with "I think" / "tbh" / "honestly" / "hot take:"\n\n` +
    `Output as JSON: {"posts": ["post 1", "post 2", "post 3"]}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
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
        temperature: 1.0,
        // 3 candidates × ~100 tokens (280 chars) = ~300 + JSON overhead → 600
        max_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: system + examplesBlock +
              '\n\nReturn JSON of the form: {"posts": ["...", "...", "..."]}.',
          },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`OpenAI HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) throw new Error('empty AI response');

    const candidates = parseCandidates(raw, count);
    return candidates;
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`OpenAI request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    logger.warn('draft', `generateDrafts failed: ${e.message}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse the JSON-mode response and clean up each candidate.
 * Rejects empties, enforces min length, dedupes, trims to 280 chars.
 */
function parseCandidates(raw, max) {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`AI returned non-JSON: ${raw.slice(0, 120)}`); }

  let arr = Array.isArray(parsed) ? parsed : parsed?.posts;
  if (!Array.isArray(arr)) {
    const firstArray = Object.values(parsed || {}).find(Array.isArray);
    arr = firstArray;
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('AI response had no usable post candidates');
  }

  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const cleaned = item
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .slice(0, MAX_POST_CHARS);
    if (!cleaned) continue;
    // Skip posts that are too short — the whole point is substantive content
    if (cleaned.length < TARGET_MIN_CHARS * 0.7) {
      logger.info('draft', `rejected candidate (${cleaned.length} chars, min ${TARGET_MIN_CHARS}): ${cleaned.slice(0, 60)}...`);
      continue;
    }
    const key = cleaned.slice(0, 60).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  if (out.length === 0) {
    throw new Error('AI candidates were all too short or duplicated after cleanup');
  }
  return out;
}

/**
 * System prompt for top-level post generation.
 *
 * Key differences from reply prompt:
 *   1. "You are posting, not replying" — prevents phantom-reply structure
 *   2. Emphasizes longer, substantive content (200-280 chars)
 *   3. Feed-context awareness — writes posts that fit the current conversation
 *   4. Hook engineering — every post must earn the reader's pause-and-read
 */
function buildPostSystemPrompt(p) {
  const parts = [];
  if (p?.name) parts.push(`Your name is ${p.name}.`);
  if (p?.bio) parts.push(`Bio: ${p.bio}`);
  if (p?.style) parts.push(`Style: ${p.style}`);

  parts.push(
    'You are posting on X (Twitter) — top-level tweets, not replies. ' +
    'No quoted tweet, no thread context — each post must stand entirely ' +
    'on its own. Reader sees only your post in their feed.',
  );

  parts.push(
    'IMPORTANT: Each post must be 200-280 characters. This is NOT optional. ' +
    'Use the full character space to deliver substance. Short one-liners ' +
    'get scrolled past. Substantive posts with a clear hook + supporting ' +
    'detail earn engagement.',
  );

  parts.push(
    'Post structure (2-4 sentences total, filling 200-280 chars):\n' +
    '1. HOOK — an unexpected claim, contrarian angle, specific data point, ' +
    'or pattern observation that makes people stop scrolling\n' +
    '2. SUBSTANCE — explain WHY, cite a mechanism, name a protocol/metric, ' +
    'or share a personal stake that grounds the hook in reality\n' +
    '3. (optional) CLOSER — a question, prediction, or call-to-discuss ' +
    'that invites replies',
  );

  parts.push(
    'Content that works: specific numbers/percentages, named protocols ' +
    'and mechanisms, "I noticed X because Y" observations, contrarian ' +
    'takes with a one-line reason, connecting two unrelated trends, ' +
    'sharing a real position/trade/action you took and why.',
  );

  parts.push(
    'Hard prohibitions: no hashtags unless natural, no 🚀🔥💎✨ emoji spam, ' +
    'no "GM" / "WAGMI" / "LFG" boilerplate, no shilling specific tickers ' +
    'with price targets, no "DYOR / NFA" — that reads as bot/promo. ' +
    'No generic "interesting times" filler. No starting with "Just..." ' +
    'or "So...". Stay in voice.',
  );

  return parts.join('\n\n');
}
