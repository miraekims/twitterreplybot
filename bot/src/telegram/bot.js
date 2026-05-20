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
import { PERSONA_PRESETS, getPreset, buildPersonaPresetKeyboard } from '../persona/presets.js';
import { generateDrafts } from '../posts/draft.js';
import { nextSlotAt } from '../posts/scheduler.js';
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
  // /settings [id] — granular per-campaign settings panel (filters,
  // pacing, sleep window, persona swap, templates hot-reload). All
  // existing slash commands keep working; this is the navigable
  // version. Without an id we route through the campaign picker so
  // the user doesn't have to remember campaign ids.
  bot.onText(/^\/settings(?:\s+(\d+))?$/, (m, mt) => guard(m, () => cmdSettingsEntry(m, mt[1] && +mt[1])));
  bot.onText(/^\/menu$/, (m) => guard(m, () => cmdMenu(m)));
  // /post <text> — immediate-publish a top-level tweet. Bypasses /draft
  // entirely; user types own copy. Schedules at "now" so the runner
  // picks it up on the next tick (≤30s).
  bot.onText(/^\/post(?:\s+([\s\S]+))?$/, (m, mt) => guard(m, () => cmdPost(m, mt[1])));
  // /draft <topic> — generate 3 candidates from a topic seed in
  // active campaign's persona voice. User approves one via inline button.
  bot.onText(/^\/draft(?:\s+([\s\S]+))?$/, (m, mt) => guard(m, () => cmdDraft(m, mt[1])));
  // /queue — list posts queued/drafted for user's campaigns.
  bot.onText(/^\/queue$/, (m) => guard(m, () => cmdQueue(m)));
  // /posts <id> — show recent posts for a campaign.
  bot.onText(/^\/posts(?:\s+(\d+))?$/, (m, mt) => guard(m, () => cmdPosts(m, mt[1] && +mt[1])));
  // /apikey — manage OpenAI/Anthropic/Groq API key from Telegram. No args
  // shows status + button menu; subcommands set/clear/url/model edit
  // individual fields. The /draft engine re-reads process.env on every
  // call, so changes apply without a restart.
  bot.onText(/^\/apikey(?:\s+(.+))?$/, (m, mt) => guard(m, () => cmdApiKey(m, mt[1])));
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
  '/menu — main menu (campaigns, settings, personas, posts, diagnose)',
  '/new — create a campaign (keywords + templates + persona)',
  '/campaigns (alias /list) — list campaigns with action buttons',
  '/run <id>, /pause <id>, /stop <id>',
  '/stats <id> — full status with inline action buttons',
  '/logs <id> — last 30 log lines',
  '/preset <id> <safe|medium|highvolume> — swap pacing profile',
  '/sleep <id> <on|off> — toggle sleep window (default 01:00-08:00)',
  '/settings [id] — full settings panel (pacing, filters, persona, templates)',
  '/diagnose [id] — show bridge + captured-op health and tips',
  '/disconnect [id] — forget account row (Chrome session itself stays)',
  '',
  'Posts (top-level tweets, not replies):',
  '/post <text> — publish a tweet on next tick (≤30s)',
  '/draft <topic> — AI generates 3 candidates in your persona voice',
  '/queue — list drafts + scheduled posts',
  '/posts <id> — recent posts for a campaign',
  '/apikey — set/manage OpenAI/Groq/custom API key (no restart needed)',
  '',
  'Tip: type "/" in chat to get a native popup with all commands.',
].join('\n');

// One-line descriptions for setMyCommands. Telegram caps these at 256 chars
// per command; keep them short and action-oriented.
const COMMAND_LIST = [
  { command: 'connect', description: 'Attach Chrome extension' },
  { command: 'accounts', description: 'Show connected X accounts' },
  { command: 'menu', description: 'Main menu — sectioned navigator' },
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
  { command: 'settings', description: 'Granular settings panel — /settings [id]' },
  { command: 'disconnect', description: 'Forget account row — /disconnect [id]' },
  { command: 'help', description: 'Show full help' },
  { command: 'post', description: 'Publish a tweet — /post <text>' },
  { command: 'draft', description: 'AI candidates — /draft <topic>' },
  { command: 'queue', description: 'List queued/drafted posts' },
  { command: 'posts', description: 'Recent posts — /posts <id>' },
  { command: 'apikey', description: 'Set OpenAI/Groq API key' },
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
  if (conv.kind === 'apikeyInput') return stepApiKeyInput(msg, conv);
  if (conv.kind === 'settingsEdit') return stepSettingsEdit(msg, conv);
  if (conv.kind === 'settingsSleep') return stepSettingsSleep(msg, conv);
  if (conv.kind === 'settingsTemplates') return stepSettingsTemplates(msg, conv);
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
      'Reply templates, one per line.\n\n' +
      'Format: "tags | text" for topic-matched, or just "text" for catch-all.\n\n' +
      'Examples:\n' +
      '  gm, good morning, gn | gm fren\n' +
      '  chart, ta, technical | nice setup, what\'s your stop?\n' +
      '  bought, longed, bullish | based, what\'s your target?\n' +
      '  big news for the space\n' +
      '\n' +
      'How matching works:\n' +
      '• Tags = comma-separated, case-insensitive substrings checked against tweet text.\n' +
      '• Multi-word tag matches if all its words appear (any order).\n' +
      '• Tweet → picks one matching template at random; falls back to catch-all.\n' +
      '• If no tags match AND no catch-all → tweet is SKIPPED (not replied to).\n' +
      '  This keeps replies on-topic instead of "gm" on a chart post.\n' +
      '\n' +
      'With OPENAI_API_KEY set, the chosen template is direction (not literal). ' +
      'AI rewrites in your persona\'s voice referring to the actual tweet.');
  }
  if (conv.step === 'templates') {
    cfg.templates = parseTemplates(text);
    if (!cfg.templates.length) {
      return bot.sendMessage(msg.chat.id,
        'No valid templates parsed. Each line must have either ' +
        '"text" (catch-all) or "tags | text". Try again.');
    }
    conv.step = 'persona';
    return bot.sendMessage(msg.chat.id,
      'Persona — pick a preset or type your own as "name | bio | style".\n\n' +
      'Presets ship with bio + style + 10 example tweet→reply pairs ' +
      'that drive AI voice fidelity (examples are 3-5x stronger than ' +
      'bio/style alone). See bot/personas/PRESETS.md for what each one ' +
      'is best at.\n\n' +
      'Tap a button below, or type your own.',
      { reply_markup: { inline_keyboard: buildPersonaPresetKeyboard() } });
  }
  if (conv.step === 'persona') {
    if (text.toLowerCase() !== 'skip') {
      const [name, bio, style] = text.split('|').map((s) => s.trim());
      cfg.persona = { name, bio, style, examples: [] };
    }
    return finalizeNewCampaign(msg.chat.id, conv);
  }
}

// Finalize the /new flow — separated so both the text-typed path and
// the preset-button callback path land in the same code without
// duplicating the DB insert + reply.
function finalizeNewCampaign(chatId, conv) {
  const cfg = conv.draft.config;
  const id = db.insertCampaign({
    account_id: conv.draft.account_id,
    name: conv.draft.name,
    config_json: JSON.stringify(cfg),
  });
  conversations.delete(chatId);
  const personaSummary = cfg.persona && cfg.persona.name
    ? `persona: ${cfg.persona.name}` +
      (cfg.persona.examples?.length ? ` (${cfg.persona.examples.length} examples)` : '')
    : 'persona: (neutral default)';
  return bot.sendMessage(chatId,
    `✓ Campaign #${id} "${conv.draft.name}" created.\n` +
    `${personaSummary}\n` +
    `Defaults: max ${cfg.pacing.maxRepliesPerHour}/h, delay ${cfg.pacing.minDelaySec}-${cfg.pacing.maxDelaySec}s.\n` +
    `Use /run ${id} to start, or /menu for the main panel.`);
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
      case 'ppreset':
        // Persona preset picker from /new flow. The "id" slot here is
        // actually the preset id (string), and "arg" is unused — we
        // override the split because preset ids contain underscores
        // and we treat the whole second segment as the preset key.
        await handlePersonaPresetPick(q, idStr);
        break;
      case 'menu':
        await handleMenuClick(q, idStr);
        break;
      case 'pdraft':
        // Auto-post draft action. callback_data shape:
        //   pdraft:<action>:<postId>
        // where action ∈ post|schedule|skip|regen
        await handleDraftAction(q, idStr, arg);
        break;
      case 'pcancel':
        // Cancel a queued post from /queue. callback_data: pcancel:<postId>
        await handlePostCancel(q, idStr);
        break;
      case 'apikey':
        // /apikey button menu. callback_data: apikey:<action>
        // action ∈ openai | groq | custom | clear | show
        await handleApiKeyAction(q, idStr);
        break;
      // ----- Settings panel (PR3) -----
      // Prefixes:
      //   set     — open settings panel for campaign id (idStr)
      //   setpick — same, but coming from the campaign-picker sub-menu
      //   setf    — flip a boolean filter; arg = field name
      //   sete    — start an edit-conversation for a numeric/string field
      //   sets    — start sleep-window edit conversation
      //   setp    — open persona swap picker for this campaign
      //   psw     — apply a persona preset to this campaign; arg = preset id
      //   sett    — start templates hot-reload conversation
      //   pswpick — campaign picker for persona swap (one extra hop)
      case 'set':
      case 'setpick':
        await openSettingsPanel(q, +idStr);
        break;
      case 'setf':
        await handleSettingFlip(q, +idStr, arg);
        break;
      case 'sete':
        await handleSettingEditPrompt(q, +idStr, arg);
        break;
      case 'sets':
        await handleSleepWindowPrompt(q, +idStr);
        break;
      case 'setp':
        await openPersonaSwapPicker(q, +idStr);
        break;
      case 'psw':
        await applyPersonaSwap(q, +idStr, arg);
        break;
      case 'sett':
        await handleTemplatesPrompt(q, +idStr);
        break;
      case 'pswpick':
        await openPersonaSwapPicker(q, +idStr);
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



// ---------- template parsing ----------
//
// Input from the /new walkthrough is multiline, one entry per line. Each
// line is either:
//   • `tags, more, tags | reply text`  (topic-matched)
//   • `reply text`                     (catch-all)
//
// Tags are comma-separated, lower-cased, trimmed. Empty tags + presence of
// "|" is malformed and dropped. The runner's pickTemplate() accepts both
// canonical objects and legacy plain strings; we always emit canonical
// objects from this parser to keep things uniform going forward.
function parseTemplates(blob) {
  const lines = String(blob || '').split('\n');
  const out = [];
  for (const raw of lines) {
    const parsed = parseTemplateLine(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseTemplateLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf('|');
  if (idx === -1) {
    // No pipe ⇒ catch-all template, the whole line is the text.
    return { match: [], text: trimmed };
  }
  const tagsStr = trimmed.slice(0, idx).trim();
  const text = trimmed.slice(idx + 1).trim();
  if (!text) return null; // "tags |" with no body is meaningless
  const match = tagsStr
    ? tagsStr.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];
  return { match, text };
}


// ---------- persona preset picker ----------
//
// Triggered when the user taps one of the inline buttons rendered at
// the persona step in /new. callback_data is "ppreset:<presetId>",
// where presetId is one of:
//   - a registered preset id (veteran/quant/sol_degen/macro/builder/contrarian)
//   - "custom"  → fall through to the existing text-typed path
//   - "skip"    → finalize without persona
//
// We deliberately do NOT mutate the original /new message — we only
// append a small confirmation. The flow's invariants (conversation
// state, finalize codepath) stay intact even if the user hits the
// wrong button: the state machine simply waits for the next event.
async function handlePersonaPresetPick(q, presetId) {
  const chatId = q.message.chat.id;
  const conv = conversations.get(chatId);
  if (!conv || conv.kind !== 'newCampaign' || conv.step !== 'persona') {
    return bot.sendMessage(chatId,
      'No campaign is awaiting a persona right now. Use /new to start one.');
  }

  if (presetId === 'skip') {
    // No persona at all — runner falls back to the neutral default
    // voice in persona.js. AI rewriting still runs if OPENAI_API_KEY
    // is set; we just don't bias it.
    return finalizeNewCampaign(chatId, conv);
  }

  if (presetId === 'custom') {
    // Keep the conversation in 'persona' step; the text handler in
    // stepNewCampaign already accepts "name | bio | style". Just
    // remind the user what the format looks like.
    return bot.sendMessage(chatId,
      'Type your persona as: "name | bio | style".\n' +
      'Example: "Alex | 3y crypto, lost 2 portfolios | cynical, lowercase, dry humor"\n\n' +
      'Or type "skip" to skip persona entirely.');
  }

  const persona = getPreset(presetId);
  if (!persona) {
    return bot.sendMessage(chatId,
      `Unknown preset "${presetId}". Use /new to retry.`);
  }
  conv.draft.config.persona = persona;
  await bot.sendMessage(chatId,
    `Loaded preset: ${persona.name} (${persona.examples?.length || 0} examples).`);
  return finalizeNewCampaign(chatId, conv);
}

// ---------- main menu (/menu) ----------
//
// Replaces the "memorize 14 slash commands" UX with a sectioned
// inline-keyboard navigator. All existing slash commands continue
// to work — /menu is purely additive.
//
// Sections:
//   📣 Campaigns — list, run/pause/stop, stats
//   ⚙ Settings  — pacing preset, sleep window, filters (planned PR2)
//   🎭 Personas  — browse presets, swap mid-campaign (planned PR2)
//   📝 Posts     — auto-post engine (planned PR4: drafts, schedule)
//   🩺 Diagnose — bridge + GraphQL op health
//   ❓ Help      — full text help
//
// Sub-section openers wired here jump straight into existing cmd*
// functions. Sections marked "planned" surface a coming-soon note
// so the menu renders complete from day one and we don't ship empty
// branches.
function buildMainMenuKeyboard() {
  return [
    [
      { text: '📣 Campaigns', callback_data: 'menu:campaigns' },
      { text: '⚙ Settings',   callback_data: 'menu:settings' },
    ],
    [
      { text: '🎭 Personas',  callback_data: 'menu:personas' },
      { text: '📝 Posts',     callback_data: 'menu:posts' },
    ],
    [
      { text: '🔑 API key',   callback_data: 'menu:apikey' },
      { text: '🩺 Diagnose',  callback_data: 'menu:diagnose' },
    ],
    [
      { text: '❓ Help',       callback_data: 'menu:help' },
    ],
  ];
}

function cmdMenu(msg) {
  // Same rationale as cmdSettingsEntry — the user opening /menu
  // mid-conversation means "drop me out of the previous flow".
  abandonSettingsConv(msg.chat.id);
  const bs = bridge.status();
  const bridgeLine = bs.connected
    ? `Bridge: ✓ @${bs.handle || '?'}`
    : 'Bridge: ✗ disconnected';
  return bot.sendMessage(msg.chat.id,
    'X Reply Bot — main menu\n' +
    bridgeLine + '\n\n' +
    'Pick a section:',
    { reply_markup: { inline_keyboard: buildMainMenuKeyboard() } });
}

async function handleMenuClick(q, section) {
  const fakeMsg = {
    from: q.from,
    chat: q.message.chat,
    message_id: q.message.message_id,
  };
  switch (section) {
    case 'campaigns':
      return cmdCampaigns(fakeMsg);
    case 'settings':
      return openSettingsCampaignPicker(fakeMsg);
    case 'personas':
      return openPersonaSwapCampaignPicker(fakeMsg);
    case 'posts':
      return bot.sendMessage(q.message.chat.id,
        '📝 Posts — auto-post engine (live)\n\n' +
        'Commands:\n' +
        '  /post <text> — publish a tweet immediately\n' +
        '  /draft <topic> — AI generates 3 candidates in your voice\n' +
        '  /queue — list queued/drafted posts\n' +
        '  /posts <id> — last 20 posts for a campaign\n\n' +
        'Why this matters: ER (engagement rate) is largely a function ' +
        'of reply-to-original ratio. Accounts that only reply trip ' +
        'spam-class detection. Posting 3-10 originals per day is the ' +
        'actual fix.\n\n' +
        'Pacing: posts auto-spaced 30min-4h apart, sleep window honored, ' +
        'daily cap 6 by default.');
    case 'diagnose':
      return cmdDiagnose(fakeMsg);
    case 'apikey':
      return cmdApiKey(fakeMsg);
    case 'help':
      return sendEphemeral(fakeMsg, HELP);
    default:
      return bot.sendMessage(q.message.chat.id,
        `Unknown menu section: ${section}`);
  }
}



// ---------- /post — immediate top-level tweet ----------
//
// /post <text> takes the user's literal text and queues it for the
// next runner tick (≤30s). Bypasses /draft entirely — for moments
// when the user already has copy in mind (or wants to bypass AI).
//
// Why we don't publish synchronously here:
//   The runner already has bridge-aware error handling, retry, and
//   logging. Going through the queue means /post has identical
//   behavior to /draft+approve, which keeps mental model simple.
//   30s of latency is acceptable for "post when ready" UX.
function cmdPost(msg, text) {
  if (!text || !text.trim()) {
    return bot.sendMessage(msg.chat.id,
      'Usage: /post <text>\n\n' +
      'Publishes a top-level tweet (NOT a reply) on the next runner ' +
      'tick (≤30s). For AI-generated candidates, use /draft <topic> instead.');
  }
  const trimmed = text.trim();
  if (trimmed.length > 280) {
    return bot.sendMessage(msg.chat.id,
      `Too long: ${trimmed.length} chars (X cap is 280). Trim and retry.`);
  }
  const cId = pickActiveCampaign(msg.from.id);
  if (!cId) return; // pickActiveCampaign already messaged the user
  const id = db.insertScheduledPost({
    campaign_id: cId,
    text: trimmed,
    scheduled_at: Date.now(),
  });
  bot.sendMessage(msg.chat.id,
    `📝 queued post #${id} for campaign #${cId}.\n` +
    `Will publish on next tick (≤30s).`);
}

// ---------- /draft — AI candidates ----------
//
// /draft <topic> generates 3 distinct candidate posts in the active
// campaign's persona voice, sends each as a separate message with
// inline action buttons (Post / Regen / Skip).
//
// The user can interact with each independently — approve one,
// regen another, skip the third. Each candidate is persisted as
// a 'draft' row so callbacks can look it up by id without us
// stuffing the entire text into callback_data (which has a 64-byte
// limit).
async function cmdDraft(msg, topic) {
  if (!topic || !topic.trim()) {
    // Try to suggest topics from feed if available
    const { getRecentFeedSample } = await import('../campaign/runner.js');
    const sample = getRecentFeedSample(5);
    const feedHint = sample.length > 0
      ? '\n\n💡 Hot in your feed right now:\n' +
        sample.slice(0, 5).map((t) => {
          const snippet = t.text.replace(/\n/g, ' ').slice(0, 60);
          return `  • "${snippet}..." (@${t.authorHandle})`;
        }).join('\n') +
        '\n\nTry: /draft <one of these topics>'
      : '';
    return bot.sendMessage(msg.chat.id,
      'Usage: /draft <topic>\n\n' +
      'Examples:\n' +
      '  /draft eth gas trends this week\n' +
      '  /draft why funding rates lie about sentiment\n' +
      '  /draft state of restaking after eigenlayer slashing\n\n' +
      'AI generates 3 candidates (200-280 chars each) in your persona ' +
      'voice, informed by what\'s trending in your feed. ' +
      'You pick one to publish (or regen / skip).' + feedHint);
  }
  const cId = pickActiveCampaign(msg.from.id);
  if (!cId) return;
  const c = db.getCampaign(cId);
  let cfg = {};
  try { cfg = JSON.parse(c.config_json); } catch {}

  // Acknowledge before the API call — generateDrafts can take 5-15s.
  const waitMsg = await bot.sendMessage(msg.chat.id,
    '🧠 Generating 3 candidates (200-280 chars, feed-aware)...');

  let candidates;
  try {
    candidates = await generateDrafts({
      topic: topic.trim(),
      persona: cfg.persona,
      count: 3,
    });
  } catch (e) {
    bot.deleteMessage(msg.chat.id, waitMsg.message_id).catch(() => {});
    return bot.sendMessage(msg.chat.id, `❌ /draft failed: ${e.message}`);
  }
  bot.deleteMessage(msg.chat.id, waitMsg.message_id).catch(() => {});

  // Persist each candidate as a draft row, then render each in its
  // own message. Independent rows = independent buttons = the user
  // can act on them in any order.
  for (let i = 0; i < candidates.length; i++) {
    const text = candidates[i];
    const draftId = db.insertDraft({
      campaign_id: cId,
      text,
      topic: topic.trim(),
    });
    await bot.sendMessage(msg.chat.id,
      `📝 ${i + 1}/${candidates.length} — ${text.length}/280 chars\n\n${text}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Post now', callback_data: `pdraft:post:${draftId}` },
            { text: '⏰ Schedule', callback_data: `pdraft:schedule:${draftId}` },
          ], [
            { text: '🔁 Regen', callback_data: `pdraft:regen:${draftId}` },
            { text: '❌ Skip', callback_data: `pdraft:skip:${draftId}` },
          ]],
        },
      });
  }
}

// ---------- /queue — drafts + scheduled posts ----------
function cmdQueue(msg) {
  const allCampaigns = db.listCampaigns(msg.from.id);
  const ownedIds = allCampaigns.map((c) => c.id);
  if (!ownedIds.length) {
    return sendEphemeral(msg, 'No campaigns. Use /new first.');
  }
  const queued = db.listQueuedPosts(ownedIds);
  if (!queued.length) {
    return sendEphemeral(msg, 'Queue is empty. Use /post or /draft to add posts.');
  }
  // Each queued post gets its own message + cancel button. Easier to
  // act on individually than a single combined list.
  for (const p of queued) {
    const when = p.status === 'scheduled' && p.scheduled_at
      ? `⏰ ${new Date(p.scheduled_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : '📝 draft';
    bot.sendMessage(msg.chat.id,
      `${when} — c#${p.campaign_id}, post #${p.id}\n\n${p.text}`,
      {
        reply_markup: {
          inline_keyboard: [[
            ...(p.status === 'draft' ? [
              { text: '✅ Post now', callback_data: `pdraft:post:${p.id}` },
              { text: '⏰ Schedule', callback_data: `pdraft:schedule:${p.id}` },
            ] : []),
            { text: '❌ Cancel', callback_data: `pcancel:${p.id}` },
          ]],
        },
      });
  }
}

// ---------- /posts — recent posts for a campaign ----------
function cmdPosts(msg, id) {
  if (!id) {
    const list = db.listCampaigns(msg.from.id);
    if (!list.length) return sendEphemeral(msg, 'No campaigns yet.');
    if (list.length === 1) id = list[0].id;
    else return sendEphemeral(msg,
      'Specify which campaign:\n' + list.map((c) => `/posts ${c.id} — ${c.name}`).join('\n'));
  }
  const c = db.getCampaign(id);
  if (!c) return sendEphemeral(msg, 'No such campaign.');
  const rows = db.recentPosts(id, 20);
  if (!rows.length) return sendEphemeral(msg, `c#${id}: no posts yet.`);
  const lines = rows.map((p) => {
    const ico = p.status === 'published' ? '✓'
              : p.status === 'scheduled' ? '⏰'
              : p.status === 'draft' ? '📝'
              : p.status === 'failed' ? '⚠'
              : p.status === 'cancelled' ? '✗'
              : '?';
    const ts = p.posted_at ? new Date(p.posted_at).toISOString().slice(0, 16).replace('T', ' ')
             : p.scheduled_at ? new Date(p.scheduled_at).toISOString().slice(0, 16).replace('T', ' ')
             : '';
    return `${ico} #${p.id} ${ts} — ${p.text.slice(0, 100).replace(/\n/g, ' ')}` +
      (p.error ? ` — ⚠ ${p.error.slice(0, 80)}` : '');
  });
  return sendEphemeral(msg,
    `Recent posts for c#${id}:\n\n` + lines.join('\n'),
    {}, /* ttl */ 5 * 60 * 1000);
}

// Find the user's active campaign for /post and /draft. With the
// bridge model the typical user has 1-2 campaigns. We pick the
// running one first; if none running, the most recently used; if
// none yet, return null and tell the user.
function pickActiveCampaign(tgUserId) {
  const list = db.listCampaigns(tgUserId);
  if (!list.length) {
    bot.sendMessage(tgUserId,
      'No campaigns yet. Use /new to create one — posts attach to a ' +
      'campaign so they share its persona voice.');
    return null;
  }
  const running = list.filter((c) => c.status === 'running');
  if (running.length === 1) return running[0].id;
  if (list.length === 1) return list[0].id;
  // Multiple campaigns and no single running one — ambiguous, but for
  // the common case of "I want to post" the user means their main
  // campaign. We pick the most recently active by last_action_at.
  const sorted = [...list].sort(
    (a, b) => (b.last_action_at || 0) - (a.last_action_at || 0),
  );
  return sorted[0].id;
}

// ---------- pdraft callback ----------
//
// callback_data: pdraft:<action>:<postId>
// action ∈ post | schedule | skip | regen
async function handleDraftAction(q, action, postIdStr) {
  const postId = +postIdStr;
  const post = db.getPost(postId);
  if (!post) {
    return bot.sendMessage(q.message.chat.id, `Draft #${postIdStr} not found.`);
  }
  // Don't let users mess with already-published or cancelled posts.
  if (post.status !== 'draft' && action !== 'skip') {
    return bot.sendMessage(q.message.chat.id,
      `Post #${postId} is in status "${post.status}", can't ${action}.`);
  }

  switch (action) {
    case 'post': {
      // Approve immediately — schedule at "now". Cancel sibling drafts
      // generated in the same batch (same topic, same campaign, draft
      // status). User picked one, others are noise now.
      db.schedulePost(postId, Date.now());
      cancelSiblingDrafts(post);
      // Edit the original message to remove buttons + show status.
      await editToFinal(q, post, '✅ Approved — publishing on next tick');
      break;
    }
    case 'schedule': {
      let cfg = {};
      try { cfg = JSON.parse(db.getCampaign(post.campaign_id).config_json); } catch {}
      cfg.__campaignId = post.campaign_id; // pass-through for nextSlotAt
      const slot = nextSlotAt(cfg);
      if (slot == null) {
        return bot.sendMessage(q.message.chat.id,
          `📅 Daily cap reached for c#${post.campaign_id}. ` +
          `Try again tomorrow, or /post to override (no cap).`);
      }
      db.schedulePost(postId, slot);
      cancelSiblingDrafts(post);
      const when = new Date(slot).toISOString().slice(0, 16).replace('T', ' ');
      await editToFinal(q, post, `⏰ Scheduled for ${when} UTC`);
      break;
    }
    case 'skip': {
      db.cancelPost(postId);
      await editToFinal(q, post, '❌ Skipped');
      break;
    }
    case 'regen': {
      // Single-candidate regeneration. Generates 1 new candidate on
      // the same topic, saves as a new draft, replaces the current
      // message buttons with the new draft's buttons.
      const c = db.getCampaign(post.campaign_id);
      let cfg = {};
      try { cfg = JSON.parse(c.config_json); } catch {}
      let fresh;
      try {
        fresh = await generateDrafts({
          topic: post.topic || '(re-roll)',
          persona: cfg.persona,
          count: 1,
        });
      } catch (e) {
        return bot.sendMessage(q.message.chat.id, `Regen failed: ${e.message}`);
      }
      const newId = db.insertDraft({
        campaign_id: post.campaign_id,
        text: fresh[0],
        topic: post.topic,
      });
      db.cancelPost(postId);
      await bot.editMessageText(
        `Regenerated — ${fresh[0].length} chars\n\n${fresh[0]}`,
        {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Post now', callback_data: `pdraft:post:${newId}` },
              { text: '⏰ Schedule', callback_data: `pdraft:schedule:${newId}` },
            ], [
              { text: '🔁 Regen', callback_data: `pdraft:regen:${newId}` },
              { text: '❌ Skip', callback_data: `pdraft:skip:${newId}` },
            ]],
          },
        },
      ).catch(() => {});
      break;
    }
    default:
      return bot.sendMessage(q.message.chat.id, `Unknown draft action: ${action}`);
  }
}

async function handlePostCancel(q, postIdStr) {
  const postId = +postIdStr;
  const post = db.getPost(postId);
  if (!post) return bot.sendMessage(q.message.chat.id, `Post #${postIdStr} not found.`);
  db.cancelPost(postId);
  await editToFinal(q, post, '❌ Cancelled');
}

// Replace the current message's buttons with a status line. We keep
// the post body visible so the user can see what they approved/skipped
// in chat history without scrolling up.
async function editToFinal(q, post, statusLine) {
  await bot.editMessageText(
    `${statusLine}\n\n${post.text}`,
    {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
      reply_markup: { inline_keyboard: [] },
    },
  ).catch(() => {});
}

// When the user approves a candidate from a /draft batch, the other
// 2 are no longer wanted. Cancel them so /queue stays clean. We
// match by topic + campaign + status='draft' since drafts in the same
// batch share both.
function cancelSiblingDrafts(approvedPost) {
  if (!approvedPost.topic) return;
  const accountCampaigns = [approvedPost.campaign_id];
  const queued = db.listQueuedPosts(accountCampaigns);
  for (const p of queued) {
    if (p.id === approvedPost.id) continue;
    if (p.status !== 'draft') continue;
    if (p.topic !== approvedPost.topic) continue;
    db.cancelPost(p.id);
  }
}




// ---------- /apikey — runtime AI provider config ----------
//
// User-friendly panel for setting OPENAI_API_KEY / OPENAI_MODEL /
// OPENAI_BASE_URL without restarting the container or editing .env.
//
// Why one command and not three: 95% of users want to do "set my
// OpenAI key" once, and never touch model/url. Default flow is
// `/apikey` → tap "🔑 OpenAI" → paste key → done. Power users
// (Groq, custom proxies, model overrides) tap into the same panel.
//
// Storage: db.app_settings table. On change we update process.env
// directly so the next /draft call uses it without restart. On
// container boot, index.js loads from DB into process.env (env
// always wins so a Docker-defined key takes precedence).
//
// Security note: the input message containing the raw key is
// deleted from the chat after we save it, so it doesn't sit in
// scrollback or get exposed via screenshot. Best-effort — Telegram
// caches messages on the server side regardless.

// We support these as separate "providers" because they need
// different baseUrl + model defaults. Adding a provider = one
// entry here, no other code changes.
const API_PROVIDERS = {
  openai: {
    label: '🔑 OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    suggestedModel: 'gpt-4o-mini',
    keyHint: 'Get one at platform.openai.com/api-keys (paid, ~$0.0002/reply for 4o-mini)',
  },
  groq: {
    label: '⚡ Groq (free)',
    baseUrl: 'https://api.groq.com/openai/v1',
    suggestedModel: 'llama-3.3-70b-versatile',
    keyHint: 'Get a free key at console.groq.com/keys — generous free tier, fast Llama 70B',
  },
  anthropic: {
    label: '🧠 Anthropic (Claude)',
    // Anthropic does NOT offer OpenAI-compatible mode natively. The
    // only zero-code path is a translating proxy. Recommended:
    // claude-bridge or LiteLLM. We document this when the user picks
    // anthropic so they know the extra hop is required.
    baseUrl: 'https://api.anthropic.com/v1',
    suggestedModel: 'claude-3-5-sonnet-20241022',
    keyHint: 'Anthropic API is NOT OpenAI-compatible. You need a proxy ' +
             '(e.g. LiteLLM at https://docs.litellm.ai) — set baseUrl to ' +
             'the proxy, paste your sk-ant-... key, model = claude-3-5-sonnet.',
  },
};

function maskKey(key) {
  if (!key) return '(unset)';
  if (key.length < 10) return '***';
  return `${key.slice(0, 6)}...${key.slice(-4)} (${key.length} chars)`;
}

// Active config, read live from process.env. Same source persona.js
// + draft.js read on every call, so what we display here is
// guaranteed to match what /draft will actually use.
function currentApiConfig() {
  return {
    key: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || '(default: gpt-4o-mini)',
    baseUrl: process.env.OPENAI_BASE_URL || '(default: api.openai.com)',
  };
}

function cmdApiKey(msg, sub) {
  // /apikey alone → status panel. /apikey clear / /apikey set /
  // /apikey model / /apikey url for explicit subcommands.
  if (sub) {
    const [cmd, ...rest] = sub.trim().split(/\s+/);
    const arg = rest.join(' ');
    if (cmd === 'set' && arg) return applyApiKey(msg.chat.id, arg);
    if (cmd === 'clear') return clearApiKey(msg.chat.id);
    if (cmd === 'model' && arg) return applyApiSetting(msg.chat.id, 'OPENAI_MODEL', arg);
    if (cmd === 'url' && arg) return applyApiSetting(msg.chat.id, 'OPENAI_BASE_URL', arg);
    return bot.sendMessage(msg.chat.id,
      'Usage:\n' +
      '  /apikey            — status + button menu\n' +
      '  /apikey set <key>  — paste an OpenAI/Groq/etc API key\n' +
      '  /apikey model <m>  — override OPENAI_MODEL\n' +
      '  /apikey url <u>    — override OPENAI_BASE_URL\n' +
      '  /apikey clear      — remove all AI config from DB');
  }

  const cfg = currentApiConfig();
  const status = cfg.key
    ? `✓ active — ${maskKey(cfg.key)}\n   model: ${cfg.model}\n   url: ${cfg.baseUrl}`
    : '✗ not set — AI replies disabled, /draft will fail';
  return bot.sendMessage(msg.chat.id,
    `🔑 AI provider config\n\n${status}\n\n` +
    `Pick a provider and paste your key — I save it in the DB and apply ` +
    `to process.env so /draft and AI replies start working immediately.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: API_PROVIDERS.openai.label, callback_data: 'apikey:openai' },
            { text: API_PROVIDERS.groq.label,   callback_data: 'apikey:groq' },
          ],
          [
            { text: API_PROVIDERS.anthropic.label, callback_data: 'apikey:anthropic' },
            { text: '🌐 Custom URL', callback_data: 'apikey:custom' },
          ],
          [
            { text: '🗑 Clear all', callback_data: 'apikey:clear' },
          ],
        ],
      },
    });
}

async function handleApiKeyAction(q, action) {
  const chatId = q.message.chat.id;
  if (action === 'clear') return clearApiKey(chatId);

  const provider = API_PROVIDERS[action];
  if (!provider && action !== 'custom') {
    return bot.sendMessage(chatId, `Unknown action: ${action}`);
  }

  if (action === 'custom') {
    // For custom: collect baseUrl first, then key. Two-step conversation.
    conversations.set(chatId, {
      kind: 'apikeyInput',
      step: 'baseUrl',
      data: {},
    });
    return bot.sendMessage(chatId,
      'Custom provider — paste the OpenAI-compatible base URL ' +
      '(e.g. `https://api.together.xyz/v1` or your own proxy).\n\n' +
      'After this you will be asked for the API key.',
      { parse_mode: 'Markdown' });
  }

  if (action === 'anthropic') {
    // Anthropic API is NOT natively OpenAI-compatible. Pre-filling
    // baseUrl=api.anthropic.com would break /draft on the next call
    // because the chat/completions shape we send isn't accepted there.
    // Route through the baseUrl-first conversation instead so the user
    // explicitly points at a translating proxy (LiteLLM / claude-bridge).
    // Suggested model is carried forward via conv.data so we can apply
    // it together with the user-supplied baseUrl.
    conversations.set(chatId, {
      kind: 'apikeyInput',
      step: 'baseUrl',
      data: { provider: 'anthropic', model: provider.suggestedModel },
    });
    return bot.sendMessage(chatId,
      '🧠 Anthropic — Claude does NOT speak OpenAI chat/completions ' +
      'natively. Run a translating proxy first, then paste its base URL.\n\n' +
      'Recommended: LiteLLM (https://docs.litellm.ai). Run it locally, ' +
      'point it at your sk-ant-... key, and the proxy exposes an ' +
      `OpenAI-compatible /v1 endpoint. Suggested model: ${provider.suggestedModel}.\n\n` +
      'Paste the proxy base URL now (e.g. http://localhost:4000/v1).');
  }

  // Known provider — pre-fill baseUrl and model, ask only for the key.
  // Apply baseUrl + model immediately; key arrives in next user message.
  db.setSetting('OPENAI_BASE_URL', provider.baseUrl);
  db.setSetting('OPENAI_MODEL', provider.suggestedModel);
  process.env.OPENAI_BASE_URL = provider.baseUrl;
  process.env.OPENAI_MODEL = provider.suggestedModel;

  conversations.set(chatId, {
    kind: 'apikeyInput',
    step: 'key',
    data: { provider: action },
  });

  return bot.sendMessage(chatId,
    `${provider.label} selected.\n\n` +
    `${provider.keyHint}\n\n` +
    `Paste your API key as the next message. I delete the message after ` +
    `saving so it doesn't sit in chat history.`);
}

function stepApiKeyInput(msg, conv) {
  const text = msg.text.trim();

  if (conv.step === 'baseUrl') {
    // Light validation — must be a URL-shaped string. Don't try to be
    // clever with regex; the actual call will fail loudly if wrong.
    if (!text.startsWith('http://') && !text.startsWith('https://')) {
      return bot.sendMessage(msg.chat.id,
        'Base URL must start with http:// or https://. Try again, or /apikey to restart.');
    }
    conv.data.baseUrl = text.replace(/\/$/, '');
    conv.step = 'key';
    return bot.sendMessage(msg.chat.id,
      `Base URL saved: ${conv.data.baseUrl}\n\n` +
      'Now paste the API key (will be saved + this message deleted).');
  }

  if (conv.step === 'key') {
    // Apply settings.
    if (conv.data.baseUrl) {
      db.setSetting('OPENAI_BASE_URL', conv.data.baseUrl);
      process.env.OPENAI_BASE_URL = conv.data.baseUrl;
    }
    if (conv.data.model) {
      // Carry-over from anthropic-via-proxy flow: we suggested a Claude
      // model up front and pinned it in conv.data so the proxy receives
      // a usable model string from the first /draft call.
      db.setSetting('OPENAI_MODEL', conv.data.model);
      process.env.OPENAI_MODEL = conv.data.model;
    }
    db.setSetting('OPENAI_API_KEY', text);
    process.env.OPENAI_API_KEY = text;
    conversations.delete(msg.chat.id);

    // Best-effort delete the message containing the secret. Telegram
    // requires the message to be <48h old, which is always true here.
    if (msg.message_id) {
      bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    }

    const cfg = currentApiConfig();
    return bot.sendMessage(msg.chat.id,
      `✅ API key saved (${maskKey(cfg.key)}).\n\n` +
      `Active config:\n` +
      `  model: ${cfg.model}\n` +
      `  url: ${cfg.baseUrl}\n\n` +
      `Test it with /draft <topic> — should generate 3 candidates in ~10s.`);
  }
}

function applyApiKey(chatId, key) {
  db.setSetting('OPENAI_API_KEY', key);
  process.env.OPENAI_API_KEY = key;
  return bot.sendMessage(chatId, `✅ API key saved (${maskKey(key)}). Try /draft <topic>.`);
}

function applyApiSetting(chatId, envKey, value) {
  db.setSetting(envKey, value);
  process.env[envKey] = value;
  return bot.sendMessage(chatId, `✅ ${envKey} = ${value}`);
}

function clearApiKey(chatId) {
  db.deleteSetting('OPENAI_API_KEY');
  db.deleteSetting('OPENAI_MODEL');
  db.deleteSetting('OPENAI_BASE_URL');
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  delete process.env.OPENAI_BASE_URL;
  return bot.sendMessage(chatId,
    '🗑 Cleared OPENAI_API_KEY / OPENAI_MODEL / OPENAI_BASE_URL.\n\n' +
    'AI replies and /draft are now disabled. Use /apikey to set up again.');
}



// ============================================================
// Settings panel (PR3)
// ============================================================
//
// Goal: the user controls every per-campaign knob from inline
// keyboards instead of remembering /preset, /sleep, and direct
// config_json edits. All existing slash commands continue to work
// — this layer is purely additive.
//
// Navigation:
//   /menu → ⚙ Settings → (campaign picker if >1) → settings panel
//   /settings [id] → settings panel directly
//
// Panel layout: a single editable message that re-renders in place
// after each toggle. Fields that take a value (numbers, lists,
// sleep window, templates) start a small text-prompt conversation
// in the same chat.
//
// callback_data prefixes used here (≤16 chars total to stay under
// Telegram's 64-byte cap with id + arg):
//   set:<id>            open settings panel for campaign
//   setpick:<id>        same; alias used by campaign picker
//   setf:<id>:<field>   flip a boolean filter (skipReplies, ...)
//   sete:<id>:<field>   start edit conversation for a value field
//   sets:<id>           start sleep-window edit conversation
//   setp:<id>           open persona swap picker for campaign
//   psw:<id>:<presetId> apply persona preset to campaign
//   pswpick:<id>        campaign picker for persona swap
//   sett:<id>           start templates hot-reload conversation

// Field metadata for value-edit prompts. Centralised so the prompt
// text, validation, parsing and storage location are co-located —
// adding a new field is one entry here, no other code changes.
const SETTING_FIELDS = {
  minLikes: {
    label: '👍 minLikes',
    where: 'filters',
    desc: 'Skip tweets with fewer than this many likes.',
    type: 'int', min: 0, max: 100000,
  },
  minAuthorFollowers: {
    label: '👥 minFollowers',
    where: 'filters',
    desc: 'Skip tweets from authors below this follower count.',
    type: 'int', min: 0, max: 100000000,
  },
  minTweetAgeSec: {
    label: '⏱ minAge (sec)',
    where: 'filters',
    desc: 'Skip tweets younger than this many seconds (lets engagement settle).',
    type: 'int', min: 0, max: 86400,
  },
  maxAgeMinutes: {
    label: '⏳ maxAge (min)',
    where: 'filters',
    desc: 'Skip tweets older than this many minutes.',
    type: 'int', min: 1, max: 60 * 24 * 7,
  },
  langs: {
    label: '🌐 langs',
    where: 'filters',
    desc: 'Comma-separated language codes (e.g. "en, ru"). Empty list = any.',
    type: 'list',
  },
  blacklistWords: {
    label: '⛔ block words',
    where: 'filters',
    desc: 'Comma-separated words to skip if they appear anywhere in tweet text.',
    type: 'list',
  },
  blacklistHandles: {
    label: '⛔ block handles',
    where: 'filters',
    desc: 'Comma-separated @handles to never reply to.',
    type: 'list',
  },
  authorCooldownHours: {
    label: '⏳ author cooldown (h)',
    where: 'pacing',
    desc: 'Hours to wait before replying to the same @handle again.',
    type: 'int', min: 0, max: 24 * 30,
  },
};

// Boolean filter flags surfaced as one-tap toggles.
const SETTING_TOGGLES = [
  { field: 'skipReplies',  label: '💬 skipReplies' },
  { field: 'skipRetweets', label: '🔁 skipRetweets' },
  { field: 'skipQuotes',   label: '💭 skipQuotes' },
  { field: 'skipWithUrls', label: '🔗 skipWithUrls' },
];

// /settings [id] entry point. Same routing as /menu Settings:
//   - 0 campaigns → nudge to /new
//   - 1 campaign → open panel directly
//   - many → render picker
function cmdSettingsEntry(msg, id) {
  // Clear any stale settings conversation. The user pressing /settings
  // mid-edit is an explicit signal that they want to restart — keeping
  // the old conv alive would mis-route their next typed value into the
  // previous field.
  abandonSettingsConv(msg.chat.id);
  if (id != null) {
    return showSettingsPanel(msg.chat.id, id, /* edit */ false);
  }
  return openSettingsCampaignPicker(msg);
}

function abandonSettingsConv(chatId) {
  const conv = conversations.get(chatId);
  if (!conv) return;
  if (conv.kind === 'settingsEdit' || conv.kind === 'settingsSleep' || conv.kind === 'settingsTemplates') {
    conversations.delete(chatId);
  }
}

// Picker that lists the user's campaigns with a button per row. We
// reuse this for the /menu → Settings entry too. When only one
// campaign exists we skip the picker and go straight to the panel,
// since picking from a list of one is a wasted tap.
function openSettingsCampaignPicker(msg) {
  const list = db.listCampaigns(msg.from.id);
  if (!list.length) {
    return bot.sendMessage(msg.chat.id,
      'No campaigns yet. Use /new to create one before editing settings.');
  }
  if (list.length === 1) {
    return showSettingsPanel(msg.chat.id, list[0].id, /* edit */ false);
  }
  const rows = list.map((c) => [{
    text: `${statusDot(c.status)} #${c.id} ${c.name}`,
    callback_data: `setpick:${c.id}`,
  }]);
  return bot.sendMessage(msg.chat.id,
    '⚙ Settings — pick a campaign:',
    { reply_markup: { inline_keyboard: rows } });
}

function statusDot(status) {
  return status === 'running' ? '🟢'
       : status === 'paused' ? '⏸'
       : status === 'error' ? '🔴'
       : '⚫';
}

// Open settings panel from a callback (campaign picker tap, or
// the dedicated "back to settings" button on a sub-screen). Edits
// the message in place where possible so we don't litter the chat
// with stale panels.
async function openSettingsPanel(q, id) {
  const c = db.getCampaign(id);
  if (!c) {
    return bot.sendMessage(q.message.chat.id, `No such campaign #${id}.`);
  }
  const { text, keyboard } = renderSettingsPanel(c);
  await bot.editMessageText(text, {
    chat_id: q.message.chat.id,
    message_id: q.message.message_id,
    reply_markup: { inline_keyboard: keyboard },
  }).catch(async () => {
    // editMessageText fails if the message is too old, in another
    // chat, or wasn't ours. Fall back to a fresh message rather
    // than dropping the action.
    await bot.sendMessage(q.message.chat.id, text, {
      reply_markup: { inline_keyboard: keyboard },
    });
  });
}

// Send a fresh settings panel (no source message to edit). Used by
// /settings <id> and from the no-picker branch above.
async function showSettingsPanel(chatId, id, _edit = false) {
  const c = db.getCampaign(id);
  if (!c) {
    return bot.sendMessage(chatId, `No such campaign #${id}.`);
  }
  const { text, keyboard } = renderSettingsPanel(c);
  return bot.sendMessage(chatId, text, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

// Render text + keyboard for the panel. We keep the formatter pure
// (no I/O) so it's trivially callable from both the /settings flow
// and any future re-render after value edits.
function renderSettingsPanel(c) {
  let cfg;
  try { cfg = JSON.parse(c.config_json); } catch { cfg = {}; }
  const filters = cfg.filters || {};
  const pacing = cfg.pacing || {};
  const sleep = cfg.sleep || {};
  const templates = Array.isArray(cfg.templates) ? cfg.templates : [];

  // Pacing summary uses the same labels /preset prints, so the
  // mental model stays consistent. Daily estimate factors sleep.
  const presetName = inferPresetName(pacing) || 'custom';
  const daily = expectedDailyReplies(cfg);
  const personaLabel = cfg.persona?.name
    ? cfg.persona.name + (cfg.persona.examples?.length ? ` (${cfg.persona.examples.length} ex.)` : '')
    : '(neutral default)';

  const lines = [
    `⚙ Settings — c#${c.id} "${c.name}"`,
    `${statusDot(c.status)} status: ${c.status}, sent total: ${c.sent_total}`,
    '',
    `📊 Pacing: ${presetName} — ${pacing.maxRepliesPerHour ?? '?'}/h, ` +
      `delay ${pacing.minDelaySec ?? '?'}-${pacing.maxDelaySec ?? '?'}s ` +
      `(~${daily}/day with current sleep)`,
    `🌙 Sleep: ${sleep.enabled ? 'ON' : 'OFF'} ${sleep.startHHMM || '??:??'}-${sleep.endHHMM || '??:??'}`,
    `🎭 Persona: ${personaLabel}`,
    `📝 Templates: ${templates.length} entries`,
    `⏳ Author cooldown: ${pacing.authorCooldownHours ?? 24}h`,
    '',
    'Filters:',
    `  👍 minLikes: ${filters.minLikes ?? 0}`,
    `  👥 minFollowers: ${filters.minAuthorFollowers ?? 0}`,
    `  ⏱ minAge: ${filters.minTweetAgeSec ?? 0}s`,
    `  ⏳ maxAge: ${filters.maxAgeMinutes ?? '?'}min`,
    `  💬 skipReplies: ${onOff(filters.skipReplies)}`,
    `  🔁 skipRetweets: ${onOff(filters.skipRetweets)}`,
    `  💭 skipQuotes: ${onOff(filters.skipQuotes)}`,
    `  🔗 skipWithUrls: ${onOff(filters.skipWithUrls)}`,
    `  🌐 langs: ${formatList(filters.langs)}`,
    `  ⛔ block words: ${(filters.blacklistWords || []).length}`,
    `  ⛔ block handles: ${(filters.blacklistHandles || []).length}`,
  ];

  // Build keyboard rows. Telegram caps text on each button (~32
  // visible chars) and we want every row balanced, so values that
  // are dynamic (current state) are echoed in the button text on
  // toggles — saves the user a re-read.
  const k = [];
  // Pacing presets row
  k.push([
    { text: '🐢 safe', callback_data: `preset:${c.id}:safe` },
    { text: '🚶 medium', callback_data: `preset:${c.id}:medium` },
    { text: '🚀 highvolume', callback_data: `preset:${c.id}:highvolume` },
  ]);
  // Sleep row — toggle + edit-hours
  k.push([
    sleep.enabled
      ? { text: '☀️ Sleep OFF', callback_data: `sleep:${c.id}:off` }
      : { text: '🌙 Sleep ON', callback_data: `sleep:${c.id}:on` },
    { text: '🛌 Edit sleep hours', callback_data: `sets:${c.id}` },
  ]);
  // Persona swap + templates hot-reload + author cooldown edit
  k.push([
    { text: '🎭 Swap persona', callback_data: `setp:${c.id}` },
    { text: '📝 Replace templates', callback_data: `sett:${c.id}` },
  ]);
  k.push([
    { text: `⏳ author cooldown (${pacing.authorCooldownHours ?? 24}h)`,
      callback_data: `sete:${c.id}:authorCooldownHours` },
  ]);
  // Filter value edits
  k.push([
    { text: `👍 minLikes (${filters.minLikes ?? 0})`,
      callback_data: `sete:${c.id}:minLikes` },
    { text: `👥 minFollowers (${filters.minAuthorFollowers ?? 0})`,
      callback_data: `sete:${c.id}:minAuthorFollowers` },
  ]);
  k.push([
    { text: `⏱ minAge (${filters.minTweetAgeSec ?? 0}s)`,
      callback_data: `sete:${c.id}:minTweetAgeSec` },
    { text: `⏳ maxAge (${filters.maxAgeMinutes ?? '?'}min)`,
      callback_data: `sete:${c.id}:maxAgeMinutes` },
  ]);
  // Filter toggles — render in pairs of two for visual density.
  for (let i = 0; i < SETTING_TOGGLES.length; i += 2) {
    const row = [];
    for (let j = 0; j < 2 && i + j < SETTING_TOGGLES.length; j++) {
      const t = SETTING_TOGGLES[i + j];
      const on = !!filters[t.field];
      row.push({
        text: `${t.label}: ${on ? 'ON' : 'OFF'}`,
        callback_data: `setf:${c.id}:${t.field}`,
      });
    }
    k.push(row);
  }
  // List filter edits
  k.push([
    { text: `🌐 langs`, callback_data: `sete:${c.id}:langs` },
    { text: `⛔ block words`, callback_data: `sete:${c.id}:blacklistWords` },
    { text: `⛔ block handles`, callback_data: `sete:${c.id}:blacklistHandles` },
  ]);
  // Run/pause/stop + stats — same as /campaigns row
  const ctrlRow = [];
  if (c.status === 'running') {
    ctrlRow.push({ text: '⏸ Pause', callback_data: `pause:${c.id}` });
  } else {
    ctrlRow.push({ text: '▶ Run', callback_data: `run:${c.id}` });
  }
  if (c.status !== 'idle') {
    ctrlRow.push({ text: '🛑 Stop', callback_data: `stop:${c.id}` });
  }
  ctrlRow.push({ text: '📊 Stats', callback_data: `stats:${c.id}` });
  ctrlRow.push({ text: '🔄 Refresh', callback_data: `set:${c.id}` });
  k.push(ctrlRow);
  return { text: lines.join('\n'), keyboard: k };
}

function onOff(b) { return b ? 'ON' : 'OFF'; }
function formatList(v) {
  if (!Array.isArray(v) || v.length === 0) return '(any)';
  return v.join(', ');
}

// Best-effort match of pacing to a named preset. We compare on the
// three knobs that distinguish them; anything else is "custom".
// Avoids importing PRESETS for a deep equals check.
function inferPresetName(pacing) {
  if (!pacing) return null;
  for (const [name, p] of Object.entries(PRESETS)) {
    if (
      pacing.maxRepliesPerHour === p.maxRepliesPerHour &&
      pacing.minDelaySec === p.minDelaySec &&
      pacing.maxDelaySec === p.maxDelaySec
    ) return name;
  }
  return null;
}

// ----- Toggle handler -----
//
// One callback per filter flip. Re-renders the panel in place so
// the user gets immediate visual confirmation that the toggle took.
async function handleSettingFlip(q, id, field) {
  if (!field || !SETTING_TOGGLES.find((t) => t.field === field)) {
    return bot.sendMessage(q.message.chat.id, `Unknown toggle: ${field}`);
  }
  const c = db.getCampaign(id);
  if (!c) return bot.sendMessage(q.message.chat.id, `No such campaign #${id}.`);
  let cfg;
  try { cfg = JSON.parse(c.config_json); } catch (e) {
    return bot.sendMessage(q.message.chat.id, `corrupt config_json: ${e.message}`);
  }
  cfg.filters = cfg.filters || {};
  cfg.filters[field] = !cfg.filters[field];
  db.setCampaignConfig(id, JSON.stringify(cfg));
  await openSettingsPanel(q, id);
}

// ----- Value-edit prompt -----
//
// Tap a value-field button → bot prompts for the new value via a
// fresh chat message. We DON'T edit the panel itself here, because
// the panel is keyboard-only; the value comes through a follow-up
// text message handled by stepSettingsEdit.
async function handleSettingEditPrompt(q, id, field) {
  const meta = SETTING_FIELDS[field];
  if (!meta) {
    return bot.sendMessage(q.message.chat.id, `Unknown field: ${field}`);
  }
  const c = db.getCampaign(id);
  if (!c) return bot.sendMessage(q.message.chat.id, `No such campaign #${id}.`);
  let cfg = {};
  try { cfg = JSON.parse(c.config_json); } catch {}
  const current = readField(cfg, meta.where, field);
  const currentLabel = meta.type === 'list'
    ? formatList(current)
    : String(current ?? '(unset)');

  conversations.set(q.message.chat.id, {
    kind: 'settingsEdit',
    campaignId: id,
    field,
    where: meta.where,
    type: meta.type,
    meta,
  });

  const constraints = meta.type === 'int'
    ? `Send a whole number (min ${meta.min}, max ${meta.max}).`
    : meta.type === 'list'
    ? 'Send a comma-separated list. Send "-" or "none" to clear.'
    : 'Send the new value.';

  return bot.sendMessage(q.message.chat.id,
    `Editing ${meta.label} for c#${id}.\n` +
    `${meta.desc}\n\n` +
    `Current: ${currentLabel}\n\n` +
    `${constraints}`);
}

function readField(cfg, where, field) {
  if (where === 'filters') return (cfg.filters || {})[field];
  if (where === 'pacing') return (cfg.pacing || {})[field];
  return undefined;
}
function writeField(cfg, where, field, value) {
  if (where === 'filters') (cfg.filters = cfg.filters || {})[field] = value;
  else if (where === 'pacing') (cfg.pacing = cfg.pacing || {})[field] = value;
}

// Conversation step: parse the user's text against the field's
// expected type, store in cfg.{filters|pacing}, persist, ack.
function stepSettingsEdit(msg, conv) {
  const text = msg.text.trim();
  const meta = conv.meta;
  let parsed;

  if (meta.type === 'int') {
    if (!/^-?\d+$/.test(text)) {
      return bot.sendMessage(msg.chat.id,
        `Not a number: "${text}". Send a whole number, or /settings to abort.`);
    }
    const n = parseInt(text, 10);
    if (n < (meta.min ?? -Infinity) || n > (meta.max ?? Infinity)) {
      return bot.sendMessage(msg.chat.id,
        `Out of range. Allowed: ${meta.min}..${meta.max}.`);
    }
    parsed = n;
  } else if (meta.type === 'list') {
    if (text === '-' || text.toLowerCase() === 'none') {
      parsed = [];
    } else {
      parsed = text.split(',').map((s) => s.trim()).filter(Boolean);
      // Normalise handle list — strip leading @, lowercase. Avoids
      // the user-sees-they-typed-it-wrong-when-it-doesn't-match
      // class of bug.
      if (conv.field === 'blacklistHandles') {
        parsed = parsed.map((s) => s.replace(/^@/, '').toLowerCase());
      }
      if (conv.field === 'langs') {
        parsed = parsed.map((s) => s.toLowerCase());
      }
    }
  } else {
    parsed = text;
  }

  const c = db.getCampaign(conv.campaignId);
  if (!c) {
    conversations.delete(msg.chat.id);
    return bot.sendMessage(msg.chat.id, `Campaign #${conv.campaignId} no longer exists.`);
  }
  let cfg;
  try { cfg = JSON.parse(c.config_json); } catch (e) {
    conversations.delete(msg.chat.id);
    return bot.sendMessage(msg.chat.id, `corrupt config_json: ${e.message}`);
  }
  writeField(cfg, conv.where, conv.field, parsed);
  db.setCampaignConfig(conv.campaignId, JSON.stringify(cfg));
  conversations.delete(msg.chat.id);

  const newLabel = meta.type === 'list' ? formatList(parsed) : String(parsed);
  return bot.sendMessage(msg.chat.id,
    `✅ ${meta.label} for c#${conv.campaignId} → ${newLabel}\n\n` +
    `Tap /settings ${conv.campaignId} to see the updated panel.`);
}

// ----- Sleep window edit -----
//
// Sleep is special because it's two values (start, end) plus an
// enabled flag. We keep the existing /sleep <id> on|off command for
// the toggle and route the panel's "Edit sleep hours" button into
// a single-line conversation: "HH:MM HH:MM".
async function handleSleepWindowPrompt(q, id) {
  const c = db.getCampaign(id);
  if (!c) return bot.sendMessage(q.message.chat.id, `No such campaign #${id}.`);
  let cfg = {};
  try { cfg = JSON.parse(c.config_json); } catch {}
  const cur = cfg.sleep || {};
  conversations.set(q.message.chat.id, {
    kind: 'settingsSleep',
    campaignId: id,
  });
  return bot.sendMessage(q.message.chat.id,
    `Editing sleep window for c#${id}.\n` +
    `Current: ${cur.startHHMM || '01:00'}-${cur.endHHMM || '08:00'} ` +
    `(${cur.enabled ? 'ON' : 'OFF'})\n\n` +
    `Send two HH:MM values separated by space or dash:\n` +
    `  01:00 08:00\n  23:00-07:00\n\n` +
    `Use /sleep ${id} on|off to toggle. /settings to abort.`);
}

function stepSettingsSleep(msg, conv) {
  const text = msg.text.trim();
  const m = text.match(/^(\d{1,2}:\d{2})\s*[-\s]\s*(\d{1,2}:\d{2})$/);
  if (!m) {
    return bot.sendMessage(msg.chat.id,
      'Format: HH:MM HH:MM (e.g. "01:00 08:00" or "23:00-07:00"). Try again, or /settings to abort.');
  }
  const start = normaliseHHMM(m[1]);
  const end = normaliseHHMM(m[2]);
  if (!start || !end) {
    return bot.sendMessage(msg.chat.id, `Invalid HH:MM. Use 24h time, e.g. 01:00 08:00.`);
  }
  const c = db.getCampaign(conv.campaignId);
  if (!c) {
    conversations.delete(msg.chat.id);
    return bot.sendMessage(msg.chat.id, `Campaign #${conv.campaignId} no longer exists.`);
  }
  let cfg;
  try { cfg = JSON.parse(c.config_json); } catch (e) {
    conversations.delete(msg.chat.id);
    return bot.sendMessage(msg.chat.id, `corrupt config_json: ${e.message}`);
  }
  cfg.sleep = cfg.sleep || {};
  cfg.sleep.startHHMM = start;
  cfg.sleep.endHHMM = end;
  db.setCampaignConfig(conv.campaignId, JSON.stringify(cfg));
  conversations.delete(msg.chat.id);
  return bot.sendMessage(msg.chat.id,
    `✅ Sleep window for c#${conv.campaignId} → ${start}-${end}.\n` +
    `Use /sleep ${conv.campaignId} on to enable.`);
}

function normaliseHHMM(s) {
  const m = String(s).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h < 0 || h > 23) return null;
  if (min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// ----- Persona swap (mid-campaign) -----
//
// Re-uses the preset registry. We don't reuse the `ppreset:` callback
// prefix because it's bound to the /new flow's conversation state;
// a separate `psw:<id>:<presetId>` keeps the two flows orthogonal.
async function openPersonaSwapPicker(q, id) {
  const c = db.getCampaign(id);
  if (!c) return bot.sendMessage(q.message.chat.id, `No such campaign #${id}.`);
  // Two-column preset grid + custom + skip + back.
  const buttons = PERSONA_PRESETS.map((p) => ({
    text: p.label,
    callback_data: `psw:${id}:${p.id}`,
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  rows.push([
    { text: '🗑 Clear (neutral)', callback_data: `psw:${id}:_clear` },
    { text: '⬅ Back to settings', callback_data: `set:${id}` },
  ]);
  let cfg = {};
  try { cfg = JSON.parse(c.config_json); } catch {}
  const cur = cfg.persona?.name || '(neutral default)';
  await bot.editMessageText(
    `🎭 Persona swap for c#${id} "${c.name}"\n` +
    `Current: ${cur}\n\n` +
    `Pick a preset (full bio + style + 10 examples preloaded), or clear.`,
    {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
      reply_markup: { inline_keyboard: rows },
    },
  ).catch(async () => {
    await bot.sendMessage(q.message.chat.id,
      `🎭 Persona swap for c#${id}.`,
      { reply_markup: { inline_keyboard: rows } });
  });
}

async function applyPersonaSwap(q, id, presetId) {
  const c = db.getCampaign(id);
  if (!c) return bot.sendMessage(q.message.chat.id, `No such campaign #${id}.`);
  let cfg;
  try { cfg = JSON.parse(c.config_json); } catch (e) {
    return bot.sendMessage(q.message.chat.id, `corrupt config_json: ${e.message}`);
  }

  if (presetId === '_clear') {
    cfg.persona = null;
    db.setCampaignConfig(id, JSON.stringify(cfg));
    await openSettingsPanel(q, id);
    return;
  }

  const persona = getPreset(presetId);
  if (!persona) {
    return bot.sendMessage(q.message.chat.id,
      `Unknown preset "${presetId}".`);
  }
  cfg.persona = persona;
  db.setCampaignConfig(id, JSON.stringify(cfg));
  await openSettingsPanel(q, id);
}

// /menu → 🎭 Personas → campaign picker → swap. With one campaign
// we go straight to the picker like Settings does.
function openPersonaSwapCampaignPicker(msg) {
  const list = db.listCampaigns(msg.from.id);
  if (!list.length) {
    return bot.sendMessage(msg.chat.id,
      'No campaigns. Use /new to create one (the persona is picked there).');
  }
  if (list.length === 1) {
    // Synthesize a fake callback so we land in the same UI.
    const fakeQ = {
      from: msg.from,
      message: { chat: msg.chat, message_id: msg.message_id },
    };
    return openPersonaSwapPicker(fakeQ, list[0].id);
  }
  const rows = list.map((c) => {
    let cfg = {};
    try { cfg = JSON.parse(c.config_json); } catch {}
    const personaName = cfg.persona?.name || 'neutral';
    return [{
      text: `${statusDot(c.status)} #${c.id} ${c.name} — ${personaName}`,
      callback_data: `pswpick:${c.id}`,
    }];
  });
  return bot.sendMessage(msg.chat.id,
    '🎭 Persona swap — pick a campaign:',
    { reply_markup: { inline_keyboard: rows } });
}

// ----- Templates hot-reload -----
//
// Re-paste the entire templates blob (one entry per line, same
// "tags | text" / "text" syntax as /new). Replaces the existing
// list outright. No partial merge — that would be confusing UX
// (users would forget what's currently saved). For partial edits
// the user can /settings <id> → see the count, then re-paste their
// full list.
async function handleTemplatesPrompt(q, id) {
  const c = db.getCampaign(id);
  if (!c) return bot.sendMessage(q.message.chat.id, `No such campaign #${id}.`);
  conversations.set(q.message.chat.id, {
    kind: 'settingsTemplates',
    campaignId: id,
  });
  return bot.sendMessage(q.message.chat.id,
    `📝 Replace templates for c#${id} "${c.name}".\n\n` +
    `Send the full new template list, one per line. Same format as /new:\n` +
    `  tags, more, tags | reply text\n` +
    `  reply text             ← no tags = catch-all\n\n` +
    `Send "-" to clear all templates (campaign will skip every tweet ` +
    `until you re-add some).\n\n` +
    `/settings to abort.`);
}

function stepSettingsTemplates(msg, conv) {
  const text = msg.text || '';
  const c = db.getCampaign(conv.campaignId);
  if (!c) {
    conversations.delete(msg.chat.id);
    return bot.sendMessage(msg.chat.id, `Campaign #${conv.campaignId} no longer exists.`);
  }
  let cfg;
  try { cfg = JSON.parse(c.config_json); } catch (e) {
    conversations.delete(msg.chat.id);
    return bot.sendMessage(msg.chat.id, `corrupt config_json: ${e.message}`);
  }
  let parsed;
  if (text.trim() === '-') {
    parsed = [];
  } else {
    parsed = parseTemplates(text);
    if (!parsed.length) {
      return bot.sendMessage(msg.chat.id,
        `No valid templates parsed. Each line must be either "text" ` +
        `(catch-all) or "tags | text". Try again, or /settings to abort.`);
    }
  }
  cfg.templates = parsed;
  db.setCampaignConfig(conv.campaignId, JSON.stringify(cfg));
  conversations.delete(msg.chat.id);
  return bot.sendMessage(msg.chat.id,
    `✅ Templates for c#${conv.campaignId} → ${parsed.length} entries saved.\n\n` +
    `Tap /settings ${conv.campaignId} to see the updated panel.`);
}
