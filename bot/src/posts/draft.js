// Auto-post drafting — generates 3 candidate top-level tweets from a
// topic seed, in the campaign's persona voice.
//
// Why this module exists separately from persona.js:
//   persona.js is reply-shaped — it expects an "original tweet by @author"
//   in the user prompt and writes a reply to it. Top-level posts have a
//   different structure: there is no quoted tweet to anchor to, the
//   model needs to invent a viewpoint, not react. Same persona /
//   examples drive voice fidelity, but the system prompt has to teach
//   the model "you're posting, not replying" — otherwise replies that
//   reference an absent tweet leak into the output ("agreed, that's why
//   I think...").
//
// Why drafts (plural) and not one shot:
//   The whole point of /draft is the user picks. AI-generated content
//   is hit-or-miss; 3 candidates lets the user keep the one that lands
//   without re-running the API call (which costs tokens AND latency).
//   We deduplicate aggressively because the model often produces near-
//   identical wording on consecutive calls at high temperature.
//
// Cost note: gpt-4o-mini at 3 candidates ≈ $0.0006 per /draft. Cheap.

import { logger } from '../core/logger.js';

const REQUEST_TIMEOUT_MS = 25_000; // 3x the per-reply budget — 3 candidates
const MAX_POST_CHARS = 280;

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
 * @param {string} [args.link]  Optional URL to surface naturally (etherscan,
 *                              debank, etc). Model is told it's optional.
 * @returns {Promise<string[]>}    Up to `count` plain-text candidates,
 *                                 deduped, capped at 280 chars each.
 *
 * Throws if OPENAI_API_KEY is unset — drafting without AI doesn't
 * produce anything useful and the user should know up-front.
 */
export async function generateDrafts({ topic, persona, count = 3, link = '' }) {
  const cfg = readConfig();
  if (!cfg.key) {
    throw new Error(
      'OPENAI_API_KEY not set. Auto-drafts need an LLM to be useful — ' +
      'set the env var or skip /draft and use /post <text> with your own copy.',
    );
  }
  if (!topic || !topic.trim()) {
    throw new Error('Topic is required. Try /draft <topic>, e.g. /draft eth gas trends.');
  }

  const system = buildPostSystemPrompt(persona);
  const examples = (persona?.examples || []).slice(0, 8); // top-8 for posts; reply structure matters less here
  const examplesBlock = examples.length
    ? '\n\nVoice samples (these are reply-shaped but the tone is the ' +
      'same):\n' + examples.map((ex, i) =>
        `${i + 1}. ${ex.reply}`,
      ).join('\n')
    : '';

  const linkClause = link
    ? `\n\nOptional: include this link naturally if relevant: ${link}\n` +
      `Don't force it. If the post reads better without, drop it.`
    : '';

  const userPrompt =
    `Topic: ${topic.trim()}\n\n` +
    `Write ${count} different candidate posts (top-level tweets, NOT replies) ` +
    `on this topic in my voice.${linkClause}\n\n` +
    `Constraints:\n` +
    `- Each ≤240 chars (X cap is 280, leave headroom)\n` +
    `- Each must take a SPECIFIC angle or claim — no generic "interesting times" filler\n` +
    `- No two candidates restate the same thesis with different words\n` +
    `- Don't open with "I think" / "tbh" / "honestly"\n` +
    `- Output as a JSON array of strings, no preamble. ` +
    `Example: ["post 1", "post 2", "post 3"]`;

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
        // Higher than reply-time temperature: candidates should diverge
        // from each other. We dedupe afterwards anyway.
        temperature: 1.0,
        // 3 candidates × ~80 tokens = 240, plus JSON overhead → 320 is
        // safe headroom without paying for runaway output.
        max_tokens: 400,
        // Force JSON mode — cheaper than parsing prose, and the model
        // is unambiguous about the shape we want.
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
 *
 * Rejects empties, dedupes identical or near-identical strings (case-
 * insensitive prefix collisions), and hard-trims to 280 chars. Returns
 * up to `max` candidates. Throws if zero survive cleanup — better to
 * fail loudly than show the user blank buttons.
 */
function parseCandidates(raw, max) {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`AI returned non-JSON: ${raw.slice(0, 120)}`); }

  let arr = Array.isArray(parsed) ? parsed : parsed?.posts;
  if (!Array.isArray(arr)) {
    // Sometimes the model puts the array under a different key; grab
    // the first array-valued field.
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
      .replace(/^["'`]+|["'`]+$/g, '') // strip stray surrounding quotes
      .slice(0, MAX_POST_CHARS);
    if (!cleaned) continue;
    // Cheap near-dup detection — first 60 chars lowercased.
    const key = cleaned.slice(0, 60).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  if (out.length === 0) {
    throw new Error('AI candidates were all empty or duplicated after cleanup');
  }
  return out;
}

/**
 * System prompt for top-level post generation. Differs from
 * persona.js's reply prompt in three ways:
 *   1. Explicitly says "you are posting, not replying" — without this,
 *      gpt-4o-mini will sometimes write replies to imagined tweets.
 *   2. Removes audience-aware framing (no thread to be seen in).
 *   3. Adds a "post must stand on its own" clause — there's no quoted
 *      tweet to provide context.
 *
 * Persona's hook techniques still apply here, but slightly differently:
 * the post itself must contain the hook, since there's no thread for
 * the reader to scroll into.
 */
function buildPostSystemPrompt(p) {
  const parts = [];
  if (p?.name) parts.push(`Your name is ${p.name}.`);
  if (p?.bio) parts.push(`Bio: ${p.bio}`);
  if (p?.style) parts.push(`Style: ${p.style}`);

  parts.push(
    'You are posting on X (Twitter) — top-level tweets, not replies. ' +
    'No quoted tweet, no thread context — each post must stand entirely ' +
    'on its own. Reader sees only your post, with no prior context.',
  );

  parts.push(
    'Each post should land a SPECIFIC observation, claim, or take in ' +
    'one or two sentences. Use ONE of these structures per post: ' +
    '(a) contrarian take with a one-line reason, ' +
    '(b) specific number/data point + your read, ' +
    '(c) tactical observation about market/protocol mechanics, ' +
    '(d) personal stake ("I just X because Y"), ' +
    '(e) reframing question. Avoid generic "thoughts on the market" filler.',
  );

  parts.push(
    'Hard prohibitions: no hashtags unless natural, no 🚀🔥💎✨ emoji, ' +
    'no "GM" / "WAGMI" / "LFG" boilerplate, no shilling specific tickers ' +
    'with a price target, no "DYOR / not financial advice" — that reads ' +
    'as bot/promo. Stay in voice.',
  );
  return parts.join(' ');
}
