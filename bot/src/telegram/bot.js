// Telegram control surface. Long-poll, no webhooks → works behind any NAT.
//
// Commands (only allowed users from TELEGRAM_ALLOWED_USERS can use them):
//   /start            — short help
//   /accounts         — list connected X accounts
//   /connect          — guides through pasting auth_token + ct0
//   /disconnect <id>  — remove an account
//   /campaigns        — list campaigns
//   /new <account_id> — interactive campaign creation
//   /run <id>         — start campaign
//   /pause <id>       — pause
//   /stop <id>        — stop & clear queue (keeps config)
//   /stats <id>       — counters & last error
//   /logs <id>        — last 30 log lines
import TelegramBot from 'node-telegram-bot-api';
import { db } from '../core/db.js';
import { encryptJSON } from '../core/crypto.js';
import { logger } from '../core/logger.js';
import { defaultCampaignConfig, presetPacing, expectedDailyReplies, PRESETS } from '../campaign/defaults.js';
import { aiActivationSummary } from '../persona/persona.js';

const PASSPHRASE = process.env.ENCRYPTION_PASSPHRASE;

let bot;
const conversations = new Map(); // chatId → { kind, step, draft }

function allowed(userId) {
  const list = (process.env.TELEGRAM_ALLOWED_USERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  return list.includes(Number(userId));
}

export function startTelegram() {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  bot.on('polling_error', (e) => logger.warn('tg', `polling: ${e.message}`));

  bot.onText(/^\/start$/, (m) => guard(m, () => bot.sendMessage(m.chat.id, HELP)));
  bot.onText(/^\/help$/, (m) => guard(m, () => bot.sendMessage(m.chat.id, HELP)));
  bot.onText(/^\/accounts$/, (m) => guard(m, () => cmdAccounts(m)));
  bot.onText(/^\/connect$/, (m) => guard(m, () => cmdConnect(m)));
  bot.onText(/^\/disconnect\s+(\d+)/, (m, mt) => guard(m, () => cmdDisconnect(m, +mt[1])));
  bot.onText(/^\/campaigns$/, (m) => guard(m, () => cmdCampaigns(m)));
  bot.onText(/^\/new\s+(\d+)/, (m, mt) => guard(m, () => cmdNew(m, +mt[1])));
  bot.onText(/^\/run\s+(\d+)/, (m, mt) => guard(m, () => cmdRun(m, +mt[1])));
  bot.onText(/^\/pause\s+(\d+)/, (m, mt) => guard(m, () => cmdSetStatus(m, +mt[1], 'paused')));
  bot.onText(/^\/stop\s+(\d+)/, (m, mt) => guard(m, () => cmdSetStatus(m, +mt[1], 'idle')));
  bot.onText(/^\/stats\s+(\d+)/, (m, mt) => guard(m, () => cmdStats(m, +mt[1])));
  bot.onText(/^\/logs\s+(\d+)/, (m, mt) => guard(m, () => cmdLogs(m, +mt[1])));
  bot.onText(/^\/preset(?:\s+(\d+)\s+(\w+))?/, (m, mt) => guard(m, () => cmdPreset(m, mt[1] && +mt[1], mt[2])));
  bot.on('message', (m) => guard(m, () => handleConversation(m)));

  logger.info('tg', 'telegram bot started (long-poll)');
}

function guard(msg, fn) {
  if (!allowed(msg.from?.id)) {
    bot.sendMessage(msg.chat.id, 'Unauthorized. Add your Telegram id to TELEGRAM_ALLOWED_USERS.');
    return;
  }
  try { return fn(); } catch (e) { logger.error('tg', e.message); bot.sendMessage(msg.chat.id, 'Error: ' + e.message); }
}

const HELP = [
  'X Reply Bot',
  '',
  '/connect — add an X account (auth_token + ct0)',
  '/accounts — list accounts',
  '/new <account_id> — create a campaign (keywords + templates)',
  '/campaigns — list campaigns',
  '/run <id>, /pause <id>, /stop <id>',
  '/stats <id>, /logs <id>',
  '/preset <id> <safe|medium|highvolume> — swap pacing profile',
  '/disconnect <account_id>',
].join('\n');

// ---------- accounts ----------
function cmdAccounts(msg) {
  const list = db.listAccounts(msg.from.id);
  if (!list.length) return bot.sendMessage(msg.chat.id, 'No accounts. Use /connect.');
  const rows = list.map((a) => `#${a.id} @${a.handle || '?'}  ${a.last_error ? '⚠ ' + a.last_error : ''}`);
  bot.sendMessage(msg.chat.id, rows.join('\n'));
}

function cmdConnect(msg) {
  conversations.set(msg.chat.id, { kind: 'connect', step: 'handle', draft: { owner_tg: msg.from.id } });
  bot.sendMessage(msg.chat.id,
    'Connect X account. I will ask for handle, auth_token, ct0.\n' +
    'How to get cookies: x.com → F12 → Application → Cookies → x.com → ' +
    'copy auth_token and ct0 values.\n\nWhat is the @handle?');
}

function cmdDisconnect(msg, id) {
  const a = db.getAccount(id);
  if (!a || a.owner_tg !== msg.from.id) return bot.sendMessage(msg.chat.id, 'Not your account.');
  db.deleteAccount(id);
  bot.sendMessage(msg.chat.id, `Account #${id} removed.`);
}

// ---------- campaigns ----------
function cmdCampaigns(msg) {
  const list = db.listCampaigns(msg.from.id);
  if (!list.length) return bot.sendMessage(msg.chat.id, 'No campaigns. Use /new <account_id>.');
  bot.sendMessage(msg.chat.id, list.map((c) =>
    `#${c.id} "${c.name}" → ${c.status}, sent: ${c.sent_total}${c.last_error ? ' ⚠ ' + c.last_error : ''}`
  ).join('\n'));
}

function cmdNew(msg, account_id) {
  const a = db.getAccount(account_id);
  if (!a || a.owner_tg !== msg.from.id) return bot.sendMessage(msg.chat.id, 'Not your account.');
  conversations.set(msg.chat.id, {
    kind: 'newCampaign',
    step: 'name',
    draft: { account_id, config: defaultCampaignConfig() },
  });
  bot.sendMessage(msg.chat.id, 'Campaign name?');
}

function cmdRun(msg, id) {
  const c = db.getCampaign(id);
  if (!c) return bot.sendMessage(msg.chat.id, 'No such campaign.');
  db.setCampaignStatus(id, 'running');
  bot.sendMessage(msg.chat.id, `▶ campaign #${id} running`);
}

function cmdSetStatus(msg, id, status) {
  db.setCampaignStatus(id, status);
  bot.sendMessage(msg.chat.id, `${status === 'idle' ? '⏹' : '⏸'} campaign #${id} → ${status}`);
}

function cmdStats(msg, id) {
  const c = db.getCampaign(id);
  if (!c) return bot.sendMessage(msg.chat.id, 'No such campaign.');
  const lastHour = db.countSentLastHour(id);
  let cfg;
  try { cfg = JSON.parse(c.config_json); } catch { cfg = {}; }
  const dailyEst = expectedDailyReplies(cfg);
  const cap = cfg?.pacing?.maxRepliesPerHour ?? '?';
  const personaLabel = cfg?.persona?.name
    ? `${cfg.persona.name}${cfg.persona.style ? ` (${cfg.persona.style.slice(0, 40)})` : ''}`
    : '(neutral default)';
  bot.sendMessage(msg.chat.id,
    `#${id} "${c.name}" — ${c.status}\n` +
    `Sent total: ${c.sent_total}, last hour: ${lastHour}\n` +
    `Cap: ${cap}/h (~${dailyEst}/day with current sleep window)\n` +
    `AI: ${aiActivationSummary()}\n` +
    `Persona: ${personaLabel}\n` +
    `Last action: ${c.last_action_at ? new Date(c.last_action_at).toISOString() : 'never'}\n` +
    (c.last_error ? `⚠ ${c.last_error}` : ''));
}

function cmdPreset(msg, id, name) {
  if (!id || !name) {
    const lines = Object.entries(PRESETS).map(([k, v]) =>
      `  ${k}: ${v.maxRepliesPerHour}/h, delay ${v.minDelaySec}-${v.maxDelaySec}s`,
    );
    return bot.sendMessage(msg.chat.id,
      'Usage: /preset <campaign_id> <safe|medium|highvolume>\n\n' +
      'Available presets:\n' + lines.join('\n') + '\n\n' +
      '⚠ highvolume targets ~1000/day. Only use on aged accounts behind a ' +
      'residential proxy with a real persona — sustained 60+/h on a cold ' +
      'account will trip X\'s spam heuristics fast.');
  }
  const c = db.getCampaign(id);
  if (!c) return bot.sendMessage(msg.chat.id, 'No such campaign.');
  let cfg;
  try { cfg = JSON.parse(c.config_json); } catch (e) {
    return bot.sendMessage(msg.chat.id, `corrupt config_json: ${e.message}`);
  }
  let pacing;
  try { pacing = presetPacing(name); }
  catch (e) { return bot.sendMessage(msg.chat.id, e.message); }
  cfg.pacing = pacing;
  db.setCampaignConfig(id, JSON.stringify(cfg));
  const daily = expectedDailyReplies(cfg);
  let warn = '';
  if (name === 'highvolume') {
    warn = '\n\n⚠ highvolume preset applied. Watch /logs for 401/403/429 ' +
           'and stop immediately if any appear.';
  }
  bot.sendMessage(msg.chat.id,
    `✓ campaign #${id} → preset "${name}"\n` +
    `Cap: ${pacing.maxRepliesPerHour}/h, delay ${pacing.minDelaySec}-${pacing.maxDelaySec}s\n` +
    `Estimated: ~${daily} replies/day with current sleep window` + warn);
}

function cmdLogs(msg, id) {
  const rows = db.recentLogs(id, 30);
  if (!rows.length) return bot.sendMessage(msg.chat.id, '(empty)');
  const txt = rows.reverse().map((r) =>
    `[${new Date(r.ts).toISOString().slice(11, 19)}] ${r.level.toUpperCase()} ${r.msg}`
  ).join('\n');
  bot.sendMessage(msg.chat.id, '```\n' + txt.slice(0, 3500) + '\n```', { parse_mode: 'Markdown' });
}

// ---------- conversational forms ----------
function handleConversation(msg) {
  if (!msg.text || msg.text.startsWith('/')) return;
  const conv = conversations.get(msg.chat.id);
  if (!conv) return;

  if (conv.kind === 'connect') return stepConnect(msg, conv);
  if (conv.kind === 'newCampaign') return stepNewCampaign(msg, conv);
}

function stepConnect(msg, conv) {
  const text = msg.text.trim();
  if (conv.step === 'handle') {
    conv.draft.handle = text.replace(/^@/, '');
    conv.step = 'auth_token';
    return bot.sendMessage(msg.chat.id, 'Now paste auth_token (long hex string from cookies).');
  }
  if (conv.step === 'auth_token') {
    conv.draft.auth_token = text;
    conv.step = 'ct0';
    return bot.sendMessage(msg.chat.id, 'Now paste ct0.');
  }
  if (conv.step === 'ct0') {
    conv.draft.ct0 = text;
    const blob = encryptJSON(PASSPHRASE, {
      auth_token: conv.draft.auth_token,
      ct0: conv.draft.ct0,
    });
    const id = db.insertAccount({
      owner_tg: conv.draft.owner_tg,
      handle: conv.draft.handle,
      secrets_blob: blob,
    });
    conversations.delete(msg.chat.id);
    return bot.sendMessage(msg.chat.id,
      `✓ Account #${id} @${conv.draft.handle} stored (encrypted).\n` +
      `Use /new ${id} to create a campaign.`);
  }
}

function stepNewCampaign(msg, conv) {
  const text = msg.text.trim();
  const cfg = conv.draft.config;
  if (conv.step === 'name') {
    conv.draft.name = text;
    conv.step = 'keywords';
    return bot.sendMessage(msg.chat.id,
      'Keywords, one per line (X search syntax supported, e.g. ' +
      '"solana min_faves:5 lang:en -filter:replies"). Send all in one message.');
  }
  if (conv.step === 'keywords') {
    cfg.keywords = text.split('\n').map((s) => s.trim()).filter(Boolean);
    conv.step = 'templates';
    return bot.sendMessage(msg.chat.id,
      'Reply templates, one per line. Supports {author}, {name}. ' +
      'If OPENAI_API_KEY is set, these are used as direction not literal text.');
  }
  if (conv.step === 'templates') {
    cfg.templates = text.split('\n').map((s) => s.trim()).filter(Boolean);
    conv.step = 'persona';
    return bot.sendMessage(msg.chat.id,
      'Persona (one line, "name | bio | style") or "skip" to use plain templates.\n' +
      'Example: "Alex | 3y crypto, lost 2 portfolios | cynical, lowercase, dry humor"');
  }
  if (conv.step === 'persona') {
    if (text.toLowerCase() !== 'skip') {
      const [name, bio, style] = text.split('|').map((s) => s.trim());
      cfg.persona = { name, bio, style, examples: [] };
    }
    const id = db.insertCampaign({
      account_id: conv.draft.account_id,
      name: conv.draft.name,
      config_json: JSON.stringify(cfg),
    });
    conversations.delete(msg.chat.id);
    return bot.sendMessage(msg.chat.id,
      `✓ Campaign #${id} "${conv.draft.name}" created.\n` +
      `Defaults: max ${cfg.pacing.maxRepliesPerHour}/h, delay ${cfg.pacing.minDelaySec}-${cfg.pacing.maxDelaySec}s.\n` +
      `Use /run ${id} to start.`);
  }
}
