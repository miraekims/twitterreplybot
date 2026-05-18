// Persona / lore-aware template rendering.
//
// Two modes:
//   - Without OPENAI_API_KEY: literal template substitution ({author}, {name}).
//   - With OPENAI_API_KEY: the template is treated as guidance, and the AI
//     produces a single-tweet reply *in the persona's voice* that references
//     the original tweet. Prevents the "thanks for the great question!" bot
//     voice that gets accounts banned in days.
//
// IMPORTANT: AI mode activates on key presence ALONE. A persona is helpful
// (more distinct voice) but not required — without one we use a sensible
// neutral voice ("matter-of-fact, lowercase, no hashtags") that is still
// dramatically better than literal templating. Earlier versions required
// both; that was a foot-gun: users picking "skip" during /new silently
// disabled AI even with a valid OPENAI_API_KEY in .env.
//
// Persona shape (stored in campaign config_json):
//   {
//     style: "cynical crypto trader, lowercase, dry humor",
//     name: "Alex",
//     bio: "trader since 2017, lost 30 ETH on Luna",
//     examples: [{ tweet: "...", reply: "..." }, ...]
//   }
//
// Env vars:
//   OPENAI_API_KEY   — required to enable AI mode
//   OPENAI_MODEL     — default 'gpt-4o-mini'. Use 'gpt-4o' for higher quality
//                      at ~10x cost (only worth it for the highvolume preset
//                      if your replies start sounding samey).
//   OPENAI_BASE_URL  — default 'https://api.openai.com/v1'. Override to point
//                      at a self-hosted proxy or an OpenAI-compatible API
//                      (Together, Groq, local llama.cpp via litellm, etc).
//
// Cost note for the 1000-replies/day target:
//   gpt-4o-mini ≈ $0.0002 per reply (in+out, ~500 tokens) → ~$0.20/day/account.
//   gpt-4o      ≈ $0.005  per reply                       → ~$5/day/account.
import { logger } from '../core/logger.js';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REPLY_CHARS = 280; // X hard cap

// Surface activation once per process so we don't spam every reply.
let _activatedLogged = false;

// Default voice when no persona is configured. Deliberately bland — the goal
// is "doesn't sound like a bot", not "stands out". A real persona almost
// always reads better; this is the floor.
const DEFAULT_VOICE = {
  style: 'matter-of-fact, lowercase, dry, occasionally cynical, no hashtags, no emoji',
};

function readConfig() {
  // Read env at call time. Lets you `docker compose up` after editing .env
  // without rebuilding the image (env_file is re-read on container start).
  return {
    key: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  };
}

export function isPersonaAiActive() {
  return Boolean(readConfig().key);
}

export function aiActivationSummary() {
  const cfg = readConfig();
  if (!cfg.key) return 'disabled (set OPENAI_API_KEY to enable)';
  const where = cfg.baseUrl === 'https://api.openai.com/v1' ? 'OpenAI' : cfg.baseUrl;
  return `enabled (model=${cfg.model}, endpoint=${where})`;
}

// Local-only literal substitution. Exported for the runner's last-resort
// fallback path (when AI is configured but the API call fails AND we still
// need to send something rather than skip the reply).
export function literalSubstitute(template, tweet) {
  return (template || '')
    .replace(/\{author\}/g, tweet.authorHandle || '')
    .replace(/\{name\}/g, tweet.authorName || '');
}

export async function rewriteTemplate({ template, tweet, persona }) {
  const cfg = readConfig();

  // No AI configured → literal substitution. Persona is irrelevant in this
  // path (it only shapes the system prompt).
  if (!cfg.key) {
    return literalSubstitute(template, tweet);
  }

  if (!_activatedLogged) {
    _activatedLogged = true;
    logger.info('persona', `AI rewriting active: ${aiActivationSummary()}`);
  }

  // Use configured persona, or fall back to the neutral default voice. We
  // do NOT silently switch to literal mode just because no persona was set
  // during /new — the user paid for an OpenAI key, they want it used.
  const effectivePersona = persona && (persona.style || persona.bio || persona.name)
    ? persona
    : DEFAULT_VOICE;

  const system = buildSystemPrompt(effectivePersona);
  const examplesBlock = (effectivePersona.examples || []).slice(0, 10).map((ex, i) =>
    `Example ${i + 1}:\nTWEET: ${ex.tweet}\nMY REPLY: ${ex.reply}`,
  ).join('\n\n');

  const user =
    `Original tweet by @${tweet.authorHandle || 'unknown'}:\n"${tweet.text}"\n\n` +
    `Template (treat as direction, not literal text):\n"${template}"\n\n` +
    `Write ONE reply, max 240 chars, in my voice. No hashtags unless natural. ` +
    `No "thanks for sharing" or similar. Plain text only. Do not start with "@" — ` +
    `X already threads the reply.`;

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
        temperature: 0.9,
        max_tokens: 120,
        messages: [
          { role: 'system', content: system + (examplesBlock ? '\n\n' + examplesBlock : '') },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`OpenAI HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty AI response');
    // Strip stray surrounding quotes the model sometimes adds.
    const clean = text.replace(/^["'`]+|["'`]+$/g, '').trim();
    // X tweets cap at 280 chars; hard-trim is a safety net, not the spec.
    return clean.slice(0, MAX_REPLY_CHARS);
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`OpenAI request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    // Don't log here — the runner's catch will, with campaign context.
    throw e;
  } finally {
    clearTimeout(tHandle);
  }
}

function buildSystemPrompt(p) {
  const parts = [];
  if (p.name) parts.push(`Your name is ${p.name}.`);
  if (p.bio) parts.push(`Bio: ${p.bio}`);
  if (p.style) parts.push(`Style: ${p.style}`);
  parts.push(
    'You are replying on X (Twitter) under a real account. Write only the ' +
    'reply text — no quotes, no preamble, no meta-commentary. Be specific to ' +
    'the tweet, not generic. Never say "great point", "absolutely", or ' +
    '"thanks for sharing". Stay in voice.',
  );
  return parts.join(' ');
}
