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
import { logger } from '../core/logger.js';

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export async function rewriteTemplate({ template, tweet, persona }) {
  // No AI configured → literal substitution.
  if (!OPENAI_KEY || !persona) {
    return template
      .replace(/\{author\}/g, tweet.authorHandle || '')
      .replace(/\{name\}/g, tweet.authorName || '');
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

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${OPENAI_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
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
    return text.slice(0, 280);
  } catch (e) {
    logger.warn('persona', `AI rewrite failed: ${e.message}`);
    throw e;
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
