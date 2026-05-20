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
import { topSpikes, TREND_DEFAULTS } from '../scout/trends.js';

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
  // /trends — show top spike terms from the trend ledger that's been
  // accumulating from each runner feed scan. AI explains "why this
  // matters" per term in the campaign's persona voice when key set.
  bot.onText(/^\/trends(?:\s+(\d+))?$/, (m, mt) => guard(m, () => cmdTrends(m, mt[1] && +mt[1])));
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
  'Trends:',
  '/trends [id] — top spike terms in your home feed over the last 6h',
  '             (with AI key: persona-voice "why this matters" per term)',
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
  { command: 'disconnect', description: 'Forget account row — /disconnect [id]' },
  { command: 'help', description: 'Show full help' },
  { command: 'post', description: 'Publish a tweet — /post <text>' },
  { command: 'draft', description: 'AI candidates — /draft <topic>' },
  { command: 'queue', description: 'List queued/drafted posts' },
  { command: 'posts', description: 'Recent posts — /posts <id>' },
  { command: 'apikey', description: 'Set OpenAI/Groq API key' },
  { command: 'trends', description: 'Top spike terms from your home feed (last 6h)' },
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
      { text: '📈 Trends',    callback_data: 'menu:trends' },
      { text: '🔑 API key',   callback_data: 'menu:apikey' },
    ],
    [
      { text: '🩺 Diagnose',  callback_data: 'menu:diagnose' },
      { text: '❓ Help',       callback_data: 'menu:help' },
    ],
  ];
}

function cmdMenu(msg) {
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
      return bot.sendMessage(q.message.chat.id,
        '⚙ Settings — per-campaign\n\n' +
        'Pick a campaign first via 📣 Campaigns, then use:\n' +
        '  /preset <id> safe|medium|highvolume — pacing\n' +
        '  /sleep <id> on|off — quiet hours\n\n' +
        'Granular settings panel (likes threshold, follower threshold, ' +
        'language filter, skip replies/retweets) is in PR2 — see ' +
        'bot/ROADMAP.md.');
    case 'personas':
      return bot.sendMessage(q.message.chat.id,
        '🎭 Personas\n\n' +
        PERSONA_PRESETS.map((p) =>
          `${p.label} — ${p.description}`,
        ).join('\n\n') +
        '\n\nPersonas are picked at /new time. Mid-campaign swap is ' +
        'planned for PR2.');
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
    case 'trends':
      return cmdTrends(fakeMsg);
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
    return bot.sendMessage(msg.chat.id,
      'Usage: /draft <topic>\n\n' +
      'Examples:\n' +
      '  /draft eth gas trends this week\n' +
      '  /draft why funding rates lie about sentiment\n' +
      '  /draft state of restaking after eigenlayer slashing\n\n' +
      'AI generates 3 candidates in your campaign\'s persona voice. ' +
      'You pick one to publish (or regen / skip).');
  }
  const cId = pickActiveCampaign(msg.from.id);
  if (!cId) return;
  const c = db.getCampaign(cId);
  let cfg = {};
  try { cfg = JSON.parse(c.config_json); } catch {}

  // Acknowledge before the API call — generateDrafts can take 5-15s.
  // Without this, the user sits staring at nothing wondering if it
  // hung, which causes them to retry, double-billing the OpenAI call.
  const waitMsg = await bot.sendMessage(msg.chat.id,
    '🧠 Generating 3 candidates...');

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
      `Candidate ${i + 1}/${candidates.length} — ${text.length} chars\n\n${text}`,
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
  const accountIds = db.listAccounts(msg.from.id).map((a) => a.id);
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
// /trends — top spike terms from the user's home feed (PR4)
// ============================================================
//
// Reads the trend_observations ledger that runner.runFeedScan
// populates on every tick. Computes the 6h-vs-18h spike score in
// scout/trends.topSpikes() and renders the top 5.
//
// When OPENAI_API_KEY is set we additionally generate a one-line
// "why this matters" per term in the campaign's persona voice. The
// AI block is optional — without a key the command still produces
// the raw spike list, which is itself useful (it tells the user
// what their feed is talking about).
//
// Cost note (with key): 5 terms × ~80 in-tokens + ~30 out-tokens ≈
// $0.0001 per /trends call on gpt-4o-mini. Negligible.

const TRENDS_AI_TIMEOUT_MS = 20_000;

async function cmdTrends(msg, id) {
  // Same campaign-resolution policy as /post and /draft: explicit id
  // wins, otherwise pick the active campaign.
  let campaignId = id;
  if (!campaignId) {
    campaignId = pickActiveCampaign(msg.from.id);
    if (!campaignId) return; // pickActiveCampaign already messaged
  } else {
    const c = db.getCampaign(campaignId);
    if (!c || !belongsToUser(c, msg.from.id)) {
      return bot.sendMessage(msg.chat.id, `No such campaign #${campaignId} (or not yours).`);
    }
  }

  const c = db.getCampaign(campaignId);
  let cfg = {};
  try { cfg = JSON.parse(c.config_json); } catch {}

  const spikes = topSpikes(campaignId);
  if (!spikes.length) {
    const headline = headlineNoSpikes(campaignId);
    return bot.sendMessage(msg.chat.id,
      `📈 Trends — c#${campaignId} "${c.name}"\n\n` +
      headline + '\n\n' +
      `Window: last ${TREND_DEFAULTS.recentWindowMs / 3600_000}h ` +
      `vs prior ${TREND_DEFAULTS.baselineWindowMs / 3600_000}h baseline.\n` +
      `Spike threshold: ≥${TREND_DEFAULTS.minRecentCount} mentions ` +
      `AND ≥${TREND_DEFAULTS.minSpikeRatio}× baseline rate.`);
  }

  // Send a "thinking" placeholder if we're going to call the LLM,
  // otherwise the user sees nothing for 5-15s and starts retrying.
  const willCallAi = !!process.env.OPENAI_API_KEY;
  const wait = willCallAi
    ? await bot.sendMessage(msg.chat.id, '🧠 Computing spikes + AI commentary...')
    : null;

  let commentary = {};
  if (willCallAi) {
    try {
      commentary = await commentSpikes(spikes, cfg.persona);
    } catch (e) {
      logger.warn('trends', `commentary failed: ${e.message}`);
      // Fall through with empty commentary; the raw spike list is
      // still useful and we already told the user it would be quick.
    }
  }
  if (wait) {
    bot.deleteMessage(msg.chat.id, wait.message_id).catch(() => {});
  }

  const lines = [
    `📈 Trends — c#${campaignId} "${c.name}"`,
    `Window: last ${TREND_DEFAULTS.recentWindowMs / 3600_000}h vs prior ` +
      `${TREND_DEFAULTS.baselineWindowMs / 3600_000}h baseline.`,
    '',
  ];
  for (let i = 0; i < spikes.length; i++) {
    const s = spikes[i];
    const why = commentary[s.term];
    const baselineLabel = s.baseline_count === 0 ? 'new' : `+${Math.round((s.ratio - 1) * 100)}%`;
    const sample = (s.last_sample_text || '').replace(/\n+/g, ' ').slice(0, 140);
    const author = s.last_author_handle ? ` (@${s.last_author_handle})` : '';
    lines.push(`${i + 1}. ${s.term} — ${s.count}× in 6h, ${baselineLabel} vs baseline`);
    if (why) lines.push(`   💡 ${why}`);
    if (sample) lines.push(`   "${sample}"${author}`);
    lines.push('');
  }
  if (!willCallAi) {
    lines.push('Tip: set OPENAI_API_KEY via /apikey to add a one-line ' +
               '"why this matters" per term in your persona voice.');
  }
  return bot.sendMessage(msg.chat.id, lines.join('\n'));
}

// Helper: when there are zero spikes, give a non-empty-feeling
// status — usually means the runner hasn't accumulated enough data
// yet (fresh campaign, just paused, or the bridge has been offline).
function headlineNoSpikes(campaignId) {
  const total24h = db.trendCountsSince(campaignId, 24 * 3600 * 1000, 1).length;
  if (total24h === 0) {
    return 'No tweets observed yet. Make sure the campaign is /run-ning ' +
           'and the Chrome extension is connected — the trend ledger fills ' +
           'in from each HomeTimeline scan the runner already does.';
  }
  if (total24h < 10) {
    return `Only ${total24h} distinct terms observed in the last 24h — ` +
           `not enough signal yet. Trends become useful after a few hours ` +
           `of active runner ticks.`;
  }
  return `${total24h} distinct terms observed in last 24h, but no spike ` +
         `passed the threshold (≥${TREND_DEFAULTS.minRecentCount} mentions ` +
         `AND ≥${TREND_DEFAULTS.minSpikeRatio}× baseline). Either the feed ` +
         `is steady today, or the campaign just started.`;
}

// Best-effort author-equality check using the campaign's account_id.
// Avoids leaking other users' campaigns when /trends gets a stray id.
function belongsToUser(c, ownerTg) {
  const a = db.getAccount(c.account_id);
  return a && a.owner_tg === ownerTg;
}

// Generate one-line "why this matters" per spike term, in persona
// voice. Single round-trip to the LLM with a JSON-mode response so
// we can map directly to terms — no parsing prose, no missing
// commentary if the model rearranged the order.
//
// Returns an object: { term1: 'reason', term2: 'reason', ... }.
// Throws on hard failures so the caller can fall back to no
// commentary cleanly.
async function commentSpikes(spikes, persona) {
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const key = process.env.OPENAI_API_KEY;
  if (!key) return {};

  // Build the persona block. Re-using persona.js's voice was tempting
  // but its system prompt is reply-shaped (anchored to a quoted
  // tweet). Trends commentary is closer to /draft's standalone-post
  // shape: short, opinionated, no thread context.
  const personaParts = [];
  if (persona?.name) personaParts.push(`Your name is ${persona.name}.`);
  if (persona?.bio) personaParts.push(`Bio: ${persona.bio}`);
  if (persona?.style) personaParts.push(`Style: ${persona.style}`);
  if (personaParts.length === 0) {
    personaParts.push('Voice: matter-of-fact, lowercase, dry, no emoji, no hashtags.');
  }

  const system =
    personaParts.join(' ') + '\n\n' +
    'You are explaining why each trending term in a crypto-Twitter feed ' +
    'matters RIGHT NOW (today). One sentence per term, ≤140 chars, in ' +
    'YOUR voice. Be specific — name the concrete development, number, ' +
    'or angle, not generic "people are talking about it". If you don\'t ' +
    'know what the term refers to from the sample tweet, say so plainly ' +
    'rather than inventing.\n\n' +
    'Return JSON: {"reasons": {"term1": "one sentence", "term2": "...", ...}}.';

  const userBlock = spikes.map((s, i) => {
    const sample = (s.last_sample_text || '').replace(/\n+/g, ' ').slice(0, 200);
    return `${i + 1}. ${s.term} — ${s.count}× in 6h, baseline ${s.baseline_count}\n` +
           `   sample: "${sample}"`;
  }).join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRENDS_AI_TIMEOUT_MS);
  let data;
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${key}`,
        'content-type': 'application/json',
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: 'Here are the trending terms:\n' + userBlock },
        ],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    data = await resp.json();
  } finally {
    clearTimeout(timer);
  }
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return {}; }
  const reasons = parsed.reasons || parsed;
  if (!reasons || typeof reasons !== 'object') return {};
  // Normalise: trim, hard-cap to 200 chars, drop empty.
  const out = {};
  for (const [k, v] of Object.entries(reasons)) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    out[k] = trimmed.slice(0, 200);
  }
  return out;
}
