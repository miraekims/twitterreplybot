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
import { defaultCampaignConfig, presetPacing, expectedDailyReplies, PRESETS, stepKeywordsHelp } from '../campaign/defaults.js';
import { aiActivationSummary } from '../persona/persona.js';
import { bridge } from '../bridge/server.js';
import { clearSoftBan } from '../campaign/runner.js';
import { setNotifier } from '../core/notify.js';

let bot;
const conversations = new Map(); // chatId → { kind, step, draft }
// Pending /connect waiters: chatId → { tgUserId, timeoutHandle }
const connectWaiters = new Map();

// Default TTL for "help-class" replies (e.g. /help, /accounts, /diagnose,
// /campaigns) that are throwaway by nature — both the user's command and
// our reply auto-delete after this many ms so the chat stays clean. Action
// confirmations and error messages skip this on purpose; you don't want
// the trail evaporating when something went wrong.
const EPHEMERAL_TTL_MS = 90_000;

// Allowed-list cache, parsed once. Used for both authz on inbound messages
// and for broadcasting notifyOwners() pings.
function allowedUserIds() {
  return (process.env.TELEGRAM_ALLOWED_USERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean).map(Number);
}

function allowed(userId) {
  return allowedUserIds().includes(Number(userId));
}

export function startTelegram() {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  bot.on('polling_error', (e) => logger.warn('tg', `polling: ${e.message}`));

  bot.onText(/^\/start$/, (m) => guard(m, () => sendEphemeral(m, HELP)));
  bot.onText(/^\/help$/, (m) => guard(m, () => sendEphemeral(m, HELP)));
  bot.onText(/^\/accounts$/, (m) => guard(m, () => cmdAccounts(m)));
  bot.onText(/^\/connect$/, (m) => guard(m, () => cmdConnect(m)));
  bot.onText(/^\/disconnect(?:\s+(\d+))?/, (m, mt) => guard(m, () => cmdDisconnect(m, mt[1] && +mt[1])));
  bot.onText(/^\/(?:campaigns|list)$/, (m) => guard(m, () => cmdCampaigns(m)));
  bot.onText(/^\/new(?:\s+(\d+))?$/, (m, mt) => guard(m, () => cmdNew(m, mt[1] && +mt[1])));
  bot.onText(/^\/run\s+(\d+)/, (m, mt) => guard(m, () => cmdRun(m, +mt[1])));
  bot.onText(/^\/pause\s+(\d+)/, (m, mt) => guard(m, () => cmdSetStatus(m, +mt[1], 'paused')));
  bot.onText(/^\/stop\s+(\d+)/, (m, mt) => guard(m, () => cmdSetStatus(m, +mt[1], 'idle')));
  bot.onText(/^\/stats\s+(\d+)/, (m, mt) => guard(m, () => cmdStats(m, +mt[1])));
  bot.onText(/^\/logs\s+(\d+)/, (m, mt) => guard(m, () => cmdLogs(m, +mt[1])));
  bot.onText(/^\/preset(?:\s+(\d+)\s+(\w+))?/, (m, mt) => guard(m, () => cmdPreset(m, mt[1] && +mt[1], mt[2])));
  bot.onText(/^\/sleep\s+(\d+)\s+(on|off)$/, (m, mt) => guard(m, () => cmdSleep(m, +mt[1], mt[2])));
  bot.onText(/^\/diag(?:nose)?(?:\s+(\d+))?$/, (m, mt) => guard(m, () => cmdDiagnose(m, mt[1] && +mt[1])));
  bot.on('message', (m) => guard(m, () => handleConversation(m)));
  bot.on('callback_query', (q) => handleCallback(q).catch((e) => {
    logger.warn('tg', `callback: ${e && e.message}`);
  }));

  // Register the visible command list with Telegram. After this, typing
  // "/" in the chat shows a native popup with all commands and one-line
  // descriptions — discoverability without us having to remember them.
  // Idempotent and cheap; safe to re-run on every boot.
  registerCommands().catch((e) => logger.warn('tg', `setMyCommands: ${e.message}`));

  // Wire the cross-module notifier so runner.js (and anything else) can
  // broadcast operator-visible warnings to Telegram. Single owner ⇒ one
  // chat; multi-owner ⇒ broadcast to all allowed user IDs (each is its
  // own private chat with the bot, chatId == userId for direct messages).
  setNotifier(async (text, opts = {}) => {
    const ids = allowedUserIds();
    if (!ids.length) return;
    const sendOpts = opts.keyboard
      ? { reply_markup: { inline_keyboard: opts.keyboard } }
      : {};
    await Promise.all(ids.map((id) =>
      bot.sendMessage(id, text, sendOpts).catch((e) => {
        // sendMessage fails if the user hasn't started a chat with the bot
        // yet (chat not initialized) or blocked it. Log once, don't crash.
        logger.warn('tg', `notify ${id}: ${e && e.message}`);
      }),
    ));
  });

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
  '/campaigns (alias /list) — list campaigns with action buttons',
  '/run <id>, /pause <id>, /stop <id>',
  '/stats <id> — full status with inline action buttons',
  '/logs <id> — last 30 log lines',
  '/preset <id> <safe|medium|highvolume> — swap pacing profile',
  '/sleep <id> <on|off> — toggle sleep window (default 01:00-08:00)',
  '/diagnose [id] — show bridge + captured-op health and tips',
  '/disconnect [id] — forget account row (Chrome session itself stays)',
  '',
  'Tip: type "/" in chat to get a native popup with all commands.',
].join('\n');

// One-line descriptions for setMyCommands. Telegram caps these at 256 chars
// per command; keep them short and action-oriented.
const COMMAND_LIST = [
  { command: 'connect', description: 'Attach Chrome extension' },
  { command: 'accounts', description: 'Show connected X accounts' },
  { command: 'new', description: 'Create a new campaign' },
  { command: 'campaigns', description: 'List campaigns + action buttons' },
  { command: 'list', description: 'Alias for /campaigns' },
  { command: 'run', description: 'Run a campaign — /run <id>' },
  { command: 'pause', description: 'Pause a campaign — /pause <id>' },
  { command: 'stop', description: 'Stop a campaign — /stop <id>' },
  { command: 'stats', description: 'Campaign stats — /stats <id>' },
  { command: 'logs', description: 'Recent log lines — /logs <id>' },
  { command: 'preset', description: 'Swap pacing — /preset <id> <name>' },
  { command: 'sleep', description: 'Sleep window — /sleep <id> on|off' },
  { command: 'diagnose', description: 'Bridge + captured-op health' },
  { command: 'disconnect', description: 'Forget account row — /disconnect [id]' },
  { command: 'help', description: 'Show full help' },
];

async function registerCommands() {
  await bot.setMyCommands(COMMAND_LIST);
  logger.info('tg', `setMyCommands → ${COMMAND_LIST.length} commands registered`);
}

// Send a message that auto-deletes itself (and the user's command, if we
// got the original `msg`) after EPHEMERAL_TTL_MS. Used for help-class
// replies — /help, /accounts, /diagnose, /campaigns list — that are
// throwaway and would otherwise clutter the chat.
//
// Telegram lets bots delete their own messages and any message in a chat
// where they have admin rights — for direct chats that's always true. If
// deleteMessage fails (e.g. message older than 48h), we just swallow the
// error: the alternative is a dangling timer that errors loudly, which
// would scare the user more than a stuck message.
async function sendEphemeral(msg, text, extra = {}, ttlMs = EPHEMERAL_TTL_MS) {
  const sent = await bot.sendMessage(msg.chat.id, text, extra);
  if (ttlMs > 0) {
    setTimeout(() => {
      bot.deleteMessage(msg.chat.id, sent.message_id).catch(() => {});
      // Also delete the user's command. Best-effort; private chats only.
      if (msg.message_id) {
        bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      }
    }, ttlMs);
  }
  return sent;
}

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
  return sendEphemeral(msg, `${bridgeLine}\n\n${lines.join('\n')}`);
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
        ' • In the extension options, the bridge URL is `ws://127.0.0.1:8787`\n' +
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
  if (!list.length) {
    return sendEphemeral(msg, 'No campaigns. Use /new.');
  }
  // One header line + per-campaign row of action buttons. Status emoji
  // makes it scannable without parsing text. Pause/Run/Stop choose
  // dynamically based on current status — only buttons that make sense
  // are shown for that row.
  const text = list.map((c) => {
    const dot = c.status === 'running' ? '🟢'
              : c.status === 'paused' ? '⏸'
              : c.status === 'error' ? '🔴'
              : '⚫';
    return `${dot} #${c.id} "${c.name}" — ${c.status}, sent ${c.sent_total}` +
      (c.last_error ? ` ⚠ ${c.last_error.slice(0, 60)}` : '');
  }).join('\n');
  const keyboard = list.flatMap((c) => buildCampaignKeyboard(c));
  return bot.sendMessage(msg.chat.id, text, {
    reply_markup: { inline_keyboard: keyboard },
  });
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
  // Clear any soft-ban backoff state from prior 404 storm. The user's
  // explicit /run is a signal to retry immediately; if the ban is real
  // x.com will 404 again and we'll re-arm.
  clearSoftBan(id);
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
  return bot.sendMessage(msg.chat.id,
    `#${id} "${c.name}" — ${c.status}\n` +
    `Sent total: ${c.sent_total}, last hour: ${lastHour}\n` +
    `Cap: ${cap}/h (~${dailyEst}/day with current sleep window)\n` +
    `AI: ${aiActivationSummary()}\n` +
    `Persona: ${personaLabel}\n` +
    `${bridgeLine}\n` +
    `${opLine}\n` +
    `Last action: ${c.last_action_at ? new Date(c.last_action_at).toISOString() : 'never'}\n` +
    (c.last_error ? `⚠ ${c.last_error}` : ''),
    {
      reply_markup: { inline_keyboard: buildCampaignKeyboard(c, /* compact */ false) },
    });
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

function cmdSleep(msg, id, onoff) {
  const c = db.getCampaign(id);
  if (!c) return bot.sendMessage(msg.chat.id, 'No such campaign.');
  let cfg;
  try { cfg = JSON.parse(c.config_json); } catch (e) {
    return bot.sendMessage(msg.chat.id, `corrupt config_json: ${e.message}`);
  }
  cfg.sleep = cfg.sleep || { startHHMM: '01:00', endHHMM: '08:00' };
  cfg.sleep.enabled = onoff === 'on';
  db.setCampaignConfig(id, JSON.stringify(cfg));
  bot.sendMessage(msg.chat.id,
    `${onoff === 'on' ? '🌙' : '☀️'} campaign #${id} sleep window ${onoff} ` +
    `(${cfg.sleep.startHHMM}-${cfg.sleep.endHHMM} local).` +
    (onoff === 'off' ? '\n\nNote: 24/7 replies put noticeably more pressure on the account. ' +
      'If you see 401/403/429 in /logs, /sleep on again.' : ''));
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
    return bot.sendMessage(msg.chat.id, stepKeywordsHelp());
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



// ---------- /diagnose ----------
//
// Shows a one-screen health check: bridge connectivity + which X.com
// GraphQL ops the extension has captured + how to fix what's missing.
// Helps the user self-serve "why isn't it replying" without us asking
// for log dumps.
//
// The KNOWN_OPS list is the set we currently care about. HomeTimeline +
// CreateTweet are mandatory for the autoreply runner. UserByScreenName
// is informational — we don't strictly need it, but it's a good signal
// that the user has actually browsed x.com after extension load.
const KNOWN_OPS = [
  { name: 'HomeTimeline', required: true,
    fix: 'open x.com/home and let the feed load (auto-warmup also does this)' },
  { name: 'HomeLatestTimeline', required: false,
    fix: 'switch the X home feed to "Latest" once' },
  { name: 'CreateTweet', required: true,
    fix: 'post any tweet manually on x.com — even just "gm" — once. ' +
         'Captured shape persists across Chrome restarts.' },
  { name: 'UserByScreenName', required: false,
    fix: 'visit any user profile on x.com once' },
];

function cmdDiagnose(msg, _id) {
  const bs = bridge.status();
  const lines = [];
  if (bs.connected) {
    lines.push(`Bridge: ✓ @${bs.handle} (v${bs.extVersion || '?'}, last pong ${ageSec(bs.lastPongAt)}s ago)`);
  } else {
    lines.push('Bridge: ✗ not connected');
    lines.push('  → start Chrome, open x.com, ensure extension is enabled.');
    lines.push('  → check extension Options: bridge URL ws://127.0.0.1:8787 + token.');
  }
  lines.push('');
  lines.push('Captured GraphQL ops:');
  const ops = bs.opSummary || {};
  let missingRequired = 0;
  for (const o of KNOWN_OPS) {
    const info = ops[o.name];
    if (info && info.lastSeen) {
      const minutesAgo = Math.round((Date.now() - info.lastSeen) / 60000);
      lines.push(`  ✓ ${o.name} — seen ${minutesAgo} min ago`);
    } else {
      const tag = o.required ? '✗ required' : '· optional';
      lines.push(`  ${tag}: ${o.name}`);
      if (o.required) {
        missingRequired++;
        lines.push(`     fix: ${o.fix}`);
      }
    }
  }
  if (missingRequired === 0 && bs.connected) {
    lines.push('');
    lines.push('All required ops captured. Bot can reply normally.');
  }
  return sendEphemeral(msg, lines.join('\n'));
}

// ---------- inline keyboards ----------
//
// Telegram callback_data has a 64-byte limit per button, and there's no
// way to attach extra context — so we encode the action and target in a
// short colon-separated string: "<action>:<id>" or "<action>:<id>:<arg>".
// All callback handlers MUST authorize on q.from.id before mutating
// state — Telegram doesn't gate inline buttons by allowed-list.

function buildCampaignKeyboard(c, compact = true) {
  // Row 1: dynamic primary action — Run if not running, Pause if
  // running, then Stop (always available). Shown regardless of compact.
  const row1 = [];
  if (c.status === 'running') {
    row1.push({ text: '⏸ Pause', callback_data: `pause:${c.id}` });
  } else {
    row1.push({ text: '▶ Run', callback_data: `run:${c.id}` });
  }
  if (c.status !== 'idle') {
    row1.push({ text: '🛑 Stop', callback_data: `stop:${c.id}` });
  }
  row1.push({ text: '📊 Stats', callback_data: `stats:${c.id}` });

  if (compact) {
    // List view — keep it to ONE row per campaign, otherwise the screen
    // gets noisy with many campaigns. Stats button on row1 lets the user
    // drill in.
    return [row1];
  }

  // Detail view (/stats <id>) — extra row with secondary actions.
  const row2 = [
    { text: '🔍 Logs', callback_data: `logs:${c.id}` },
    { text: '🩺 Diagnose', callback_data: `diagnose:${c.id}` },
  ];
  const row3 = [
    { text: '🐢 safe', callback_data: `preset:${c.id}:safe` },
    { text: '🚶 medium', callback_data: `preset:${c.id}:medium` },
    { text: '🚀 highvolume', callback_data: `preset:${c.id}:highvolume` },
  ];
  // Sleep toggle reflects current state so the button text isn't a lie.
  let sleepEnabled = false;
  try { sleepEnabled = !!JSON.parse(c.config_json)?.sleep?.enabled; } catch {}
  const row4 = [
    sleepEnabled
      ? { text: '☀️ Sleep OFF', callback_data: `sleep:${c.id}:off` }
      : { text: '🌙 Sleep ON', callback_data: `sleep:${c.id}:on` },
  ];
  return [row1, row2, row3, row4];
}

async function handleCallback(q) {
  // Authorization first — reject silently to anyone not in the allowed
  // list. answerCallbackQuery just makes the spinner go away on the
  // user's button click.
  if (!allowed(q.from?.id)) {
    return bot.answerCallbackQuery(q.id, { text: 'Unauthorized', show_alert: false });
  }
  const data = q.data || '';
  const [action, idStr, arg] = data.split(':');
  const id = +idStr;
  // Synthesize a minimal `msg` shim for cmd* functions. They expect
  // .from, .chat, .message_id (used by sendEphemeral for cleanup).
  // We use the bot's reply message id, since the user's "command" here
  // is a button press — there's no user-typed message to clean up.
  const fakeMsg = {
    from: q.from,
    chat: q.message.chat,
    message_id: q.message.message_id,
  };

  try {
    switch (action) {
      case 'run':
        cmdRun(fakeMsg, id);
        break;
      case 'pause':
        cmdSetStatus(fakeMsg, id, 'paused');
        break;
      case 'stop':
        cmdSetStatus(fakeMsg, id, 'idle');
        break;
      case 'stats':
        cmdStats(fakeMsg, id);
        break;
      case 'logs':
        cmdLogs(fakeMsg, id);
        break;
      case 'diagnose':
        cmdDiagnose(fakeMsg, id);
        break;
      case 'preset':
        cmdPreset(fakeMsg, id, arg);
        break;
      case 'sleep':
        cmdSleep(fakeMsg, id, arg);
        break;
      default:
        await bot.answerCallbackQuery(q.id, { text: `Unknown action: ${action}` });
        return;
    }
    await bot.answerCallbackQuery(q.id);
  } catch (e) {
    await bot.answerCallbackQuery(q.id, { text: `Error: ${e.message}`.slice(0, 200), show_alert: true });
  }
}
