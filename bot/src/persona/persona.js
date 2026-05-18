// Persona / lore-aware template rendering.
//
// Two modes:
//   - Without OPENAI_API_KEY: literal template substitution ({author}, {name}).
//   - With OPENAI_API_KEY: the template is treated as guidance, and the AI
//     produces a single-tweet reply *in the persona's voice* that references
//     the original tweet. Prevents the "thanks for the great question!" bot
//     voice that gets accounts banned in days.
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
//                      at a self-hosted proxy or an Anthropic-compatible API.
//
// Cost note for the 1000-replies/day target:
//   gpt-4o-mini ≈ $0.0002 per reply (in+out, ~500 tokens) → ~$0.20/day/account.
//   gpt-4o      ≈ $0.005  per reply                       → ~$5/day/account.
import { logger } from '../core/logger.js';

const REQUEST_TIMEOUT_MS = 20_000;

let _activatedLogged = false;

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

export async function rewriteTemplate({ template, tweet, persona }) {
  const cfg = readConfig();

  // No AI configured → literal substitution.
  if (!cfg.key || !persona) {
    return template
      .replace(/\{author\}/g, tweet.authorHandle || '')
      .replace(/\{name\}/g, tweet.authorName || '');
  }

  if (!_activatedLogged) {
    _activatedLogged = true;
    const where = cfg.baseUrl === 'https://api.openai.com/v1' ? 'OpenAI' : cfg.baseUrl;
    logger.info('persona', `AI rewriting active: model=${cfg.model}, endpoint=${where}`);
  }

  const system = buildSystemPrompt(persona);
  const examplesBlock = (persona.examples || []).slice(0, 10).map((ex, i) =>
    `Example ${i + 1}:\nTWEET: ${ex.tweet}\nMY REPLY: ${ex.reply}`,
  ).join('\n\n');

  const user =
    `Original tweet by @${tweet.authorHandle}:\n"${tweet.text}"\n\n` +
    `Template (treat as direction, not literal text):\n"${template}"\n\n` +
    `Write ONE reply, max 240 chars, in my voice. No hashtags unless natural. ` +
    `No "thanks for sharing" or similar. Plain text only.`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
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
      const t = await resp.text().catch(() => '');
      throw new Error(`OpenAI HTTP ${resp.status}: ${t.slice(0, 200)}`);
    }
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty AI response');
    // X tweets cap at 280 chars; 240 leaves room for a leading @handle if
    // the model omitted it. Hard-trim is a safety net, not the spec.
    return text.slice(0, 280);
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`OpenAI request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    logger.warn('persona', `AI rewrite failed: ${e.message}`);
    throw e;
  } finally {
    clearTimeout(t);
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
    'the tweet, not generic. Never say "great point" or "absolutely". Stay in voice.',
  );
  return parts.join(' ');
}
