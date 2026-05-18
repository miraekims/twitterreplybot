// Telegram control surface. Long-poll, no webhooks → works behind any NAT.
//
// Commands:
//   /start            — short help
//   /accounts         — list connected X account (just one with the bridge model)
//   /connect          — wait for Chrome extension to register
//   /disconnect       — forget the registered account (Chrome session stays
//                       intact; this only removes the row in our DB)
//   /campaigns        — list campaigns
//   /new              — interactive campaign creation (no account_id needed —
//                       there's only ever one)
//   /run <id>, /pause <id>, /stop <id>
//   /stats <id>, /logs <id>, /preset <id> <name>
//
// Identity model with the bridge:
//   - The Chrome extension authenticates to the bot bridge (shared token in
//     .env). On connect it tells us which @handle is logged in.
//   - We persist a single account row per handle, no secrets — Chrome owns
//     them. When Chrome reconnects under a different handle, we add another
//     row, but only one is "active" (whichever Chrome currently broadcasts).
//   - Campaigns reference account_id like before, so old DB rows still work.
import TelegramBot from 'node-telegram-bot-api';
import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { defaultCampaignConfig, presetPacing, expectedDailyReplies, PRESETS } from '../campaign/defaults.js';
import { aiActivationSummary } from '../persona/persona.js';
import { bridge } from '../bridge/server.js';

let bot;
const conversations = new Map(); // chatId → { kind, step, draft }
// Pending /connect waiters: chatId → { tgUserId, timeoutHandle }
const connectWaiters = new Map();

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
  bot.onText(/^\/disconnect(?:\s+(\d+))?/, (m, mt) => guard(m, () => cmdDisconnect(m, mt[1] && +mt[1])));
  bot.onText(/^\/campaigns$/, (m) => guard(m, () => cmdCampaigns(m)));
  bot.onText(/^\/new(?:\s+(\d+))?$/, (m, mt) => guard(m, () => cmdNew(m, mt[1] && +mt[1])));
  bot.onText(/^\/run\s+(\d+)/, (m, mt) => guard(m, () => cmdRun(m, +mt[1])));
  bot.onText(/^\/pause\s+(\d+)/, (m, mt) => guard(m, () => cmdSetStatus(m, +mt[1], 'paused')));
  bot.onText(/^\/stop\s+(\d+)/, (m, mt) => guard(m, () => cmdSetStatus(m, +mt[1], 'idle')));
  bot.onText(/^\/stats\s+(\d+)/, (m, mt) => guard(m, () => cmdStats(m, +mt[1])));
  bot.onText(/^\/logs\s+(\d+)/, (m, mt) => guard(m, () => cmdLogs(m, +mt[1])));
  bot.onText(/^\/preset(?:\s+(\d+)\s+(\w+))?/, (m, mt) => guard(m, () => cmdPreset(m, mt[1] && +mt[1], mt[2])));
  bot.on('message', (m) => guard(m, () => handleConversation(m)));

  // Resolve any pending /connect waiter the moment the extension hellos.
  bridge.onConnect(async (status) => {
    for (const [chatId, w] of connectWaiters) {
      clearTimeout(w.timeoutHandle);
      try {
        const accountId = ensureAccountForHandle(w.tgUserId, status.handle);
        await bot.sendMessage(
          chatId,
          `✓ Extension connected: @${status.handle || '?'} (v${status.extVersion || '?'})\n` +
          `Account #${accountId} ready. Use /new to create a campaign.`,
        );
      } catch (e) {
        await bot.sendMessage(chatId, `Extension connected but DB error: ${e.message}`);
      }
      connectWaiters.delete(chatId);
    }
  });

  bridge.onDisconnect((info) => {
    // Surface disconnects to anyone in /connect waiting state too — they
    // were probably watching anyway.
    logger.warn('tg', `extension disconnected: @${info.handle || '?'}`);
  });

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
  '/connect — wait for the Chrome extension to attach',
  '/accounts — list connected X account(s)',
  '/new — create a campaign (keywords + templates + persona)',
  '/campaigns — list campaigns',
  '/run <id>, /pause <id>, /stop <id>',
  '/stats <id>, /logs <id>',
  '/preset <id> <safe|medium|highvolume> — swap pacing profile',
  '/disconnect [id] — forget account row (Chrome session itself stays)',
].join('\n');

// ---------- accounts ----------
function ensureAccountForHandle(owner_tg, handle) {
  // Look up an existing row by handle for this user; if not found, insert
  // a new one with empty secrets_blob (we don't have or need them anymore).
  const list = db.listAccounts(owner_tg);
  const existing = list.find((a) => a.handle === handle);
  if (existing) return existing.id;
  return db.insertAccount({
    owner_tg,
    handle,
    secrets_blob: '', // intentionally empty — Chrome owns the session now
  });
}

function cmdAccounts(msg) {
  const list = db.listAccounts(msg.from.id);
  const status = bridge.status();
  const lines = list.length
    ? list.map((a) => {
        const live = status.connected && status.handle === a.handle ? ' (live)' : '';
        return `#${a.id} @${a.handle || '?'}${live}${a.last_error ? '  ⚠ ' + a.last_error : ''}`;
      })
    : ['(none yet — use /connect)'];
  const bridgeLine = status.connected
    ? `Bridge: ✓ connected as @${status.handle} (v${status.extVersion || '?'})`
    : 'Bridge: ✗ not connected — open Chrome with the extension on x.com';
  bot.sendMessage(msg.chat.id, `${bridgeLine}\n\n${lines.join('\n')}`);
}

function cmdConnect(msg) {
  const status = bridge.status();
  if (status.connected) {
    const accountId = ensureAccountForHandle(msg.from.id, status.handle);
    return bot.sendMessage(
      msg.chat.id,
      `✓ Extension already connected: @${status.handle}\n` +
      `Account #${accountId} ready. Use /new to create a campaign.`,
    );
  }
  // Wait up to 90 sec for the extension to hello.
  const timeoutHandle = setTimeout(() => {
    if (connectWaiters.has(msg.chat.id)) {
      connectWaiters.delete(msg.chat.id);
      bot.sendMessage(
        msg.chat.id,
        '⏱ Timed out waiting for extension.\n\n' +
        'Checklist:\n' +
        ' • Chrome is running on this Mac\n' +
        ' • You are logged into x.com in some tab\n' +
        ' • The X Reply Bot extension is enabled (chrome://extensions)\n' +
        ' • In the extension options, the bridge URL is `ws://host.docker.internal:8787`\n' +
        '   and the token matches XBOT_BRIDGE_TOKEN in bot/.env',
      );
    }
  }, 90 * 1000);
  connectWaiters.set(msg.chat.id, { tgUserId: msg.from.id, timeoutHandle });
  bot.sendMessage(
    msg.chat.id,
    'Waiting for Chrome extension to attach...\n\n' +
    'Open Chrome → make sure you are logged into x.com → extension auto-connects.\n' +
    'I will reply here as soon as it does (or after 90s if it doesn\'t).',
  );
}

function cmdDisconnect(msg, id) {
  const list = db.listAccounts(msg.from.id);
  if (!list.length) return bot.sendMessage(msg.chat.id, 'No account rows to remove.');
  // Single-account default: if no id given and only one row exists, drop that one.
  if (id == null) {
    if (list.length === 1) id = list[0].id;
    else return bot.sendMessage(msg.chat.id,
      'Multiple account rows. Use /disconnect <id>:\n' + list.map((a) => `  ${a.id} @${a.handle}`).join('\n'));
  }
  const a = db.getAccount(id);
  if (!a || a.owner_tg !== msg.from.id) return bot.sendMessage(msg.chat.id, 'Not your account.');
  db.deleteAccount(id);
  bot.sendMessage(msg.chat.id,
    `Account #${id} removed from DB.\n` +
    `(The Chrome session itself is untouched — log out in Chrome too if you want a clean slate.)`);
}

// ---------- campaigns ----------
function cmdCampaigns(msg) {
  const list = db.listCampaigns(msg.from.id);
  if (!list.length) return bot.sendMessage(msg.chat.id, 'No campaigns. Use /new.');
  bot.sendMessage(msg.chat.id, list.map((c) =>
    `#${c.id} "${c.name}" → ${c.status}, sent: ${c.sent_total}${c.last_error ? ' ⚠ ' + c.last_error : ''}`
  ).join('\n'));
}

function cmdNew(msg, account_id) {
  // /new without an id: pick the user's only account (or fall back to a
  // helpful error if there's a tie). With the bridge model, a user almost
  // always has exactly one row anyway.
  const owned = db.listAccounts(msg.from.id);
  if (account_id == null) {
    if (!owned.length) return bot.sendMessage(msg.chat.id,
      'No connected accounts. Use /connect first to attach the Chrome extension.');
    if (owned.length > 1) return bot.sendMessage(msg.chat.id,
      'Multiple accounts. Specify which:\n/new ' + owned.map((a) => `${a.id} (@${a.handle})`).join('\n/new '));
    account_id = owned[0].id;
  }
  const a = db.getAccount(account_id);
  if (!a || a.owner_tg !== msg.from.id) return bot.sendMessage(msg.chat.id, 'Not your account.');
  conversations.set(msg.chat.id, {
    kind: 'newCampaign',
    step: 'name',
    draft: { account_id, config: defaultCampaignConfig() },
  });
  bot.sendMessage(msg.chat.id, `Creating campaign for @${a.handle || '?'}.\nCampaign name?`);
}

function cmdRun(msg, id) {
  const c = db.getCampaign(id);
  if (!c) return bot.sendMessage(msg.chat.id, 'No such campaign.');
  if (!bridge.isConnected()) {
    return bot.sendMessage(msg.chat.id,
      '⚠ Bridge not connected. Campaign will idle until Chrome extension attaches.\n' +
      'Use /connect to wait for it, or just start Chrome — the campaign will pick up automatically.');
  }
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
  const bs = bridge.status();
  const bridgeLine = bs.connected
    ? `Bridge: ✓ @${bs.handle} (last pong ${ageSec(bs.lastPongAt)}s ago)`
    : 'Bridge: ✗ disconnected';
  const opLine = bs.opSummary
    ? `Last op refresh: ${freshestOpAge(bs.opSummary)}`
    : 'Last op refresh: unknown';
  bot.sendMessage(msg.chat.id,
    `#${id} "${c.name}" — ${c.status}\n` +
    `Sent total: ${c.sent_total}, last hour: ${lastHour}\n` +
    `Cap: ${cap}/h (~${dailyEst}/day with current sleep window)\n` +
    `AI: ${aiActivationSummary()}\n` +
    `Persona: ${personaLabel}\n` +
    `${bridgeLine}\n` +
    `${opLine}\n` +
    `Last action: ${c.last_action_at ? new Date(c.last_action_at).toISOString() : 'never'}\n` +
    (c.last_error ? `⚠ ${c.last_error}` : ''));
}

function ageSec(ts) {
  if (!ts) return '?';
  return Math.max(0, Math.round((Date.now() - ts) / 1000));
}

function freshestOpAge(opSummary) {
  if (!opSummary || typeof opSummary !== 'object') return 'unknown';
  // The extension sends { OpName: { lastSeen, queryId } }. The "freshest"
  // operation is the one we last observed live on the page — closest proxy
  // to "is the user actively browsing x.com / are headers fresh".
  let newest = 0;
  let newestName = null;
  for (const [name, info] of Object.entries(opSummary)) {
    if (info?.lastSeen && info.lastSeen > newest) {
      newest = info.lastSeen;
      newestName = name;
    }
  }
  if (!newest) return 'never';
  const minutesAgo = Math.round((Date.now() - newest) / 60000);
  return `${newestName} ${minutesAgo} min ago`;
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
  if (conv.kind === 'newCampaign') return stepNewCampaign(msg, conv);
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
