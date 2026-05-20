// Per-tick campaign logic. Called from the supervisor every 5s for each
// running campaign. At most one X.com action per tick.
//
// Decision tree:
//   1. extension bridge disconnected? → idle (don't burn cooldown)
//   2. sleep window? → bail
//   3. hourly cap reached? → bail
//   4. cooldown since last action not elapsed? → bail
//   5. queue empty + scrollEverySec elapsed? → fetch next HomeTimeline
//      page, filter locally by keywords, push to queue
//   6. queue has items? → reply to next tweet, dedup-mark
//
// Why HomeTimeline + local filtering instead of SearchTimeline:
//
//   We tried SearchTimeline first (one search per keyword per cycle). X
//   soft-banned the account inside an hour: every /graphql/.../SearchTimeline
//   started returning HTTP 404 with empty body, even direct fetches from
//   the user's own browser DevTools. SearchTimeline is treated as a
//   "rare ad-hoc" endpoint by X — real users only search a handful of
//   times per day, so anything above ~30 calls/h trips its WAF.
//
//   HomeTimeline is the every-scroll feed endpoint. Real users hit it
//   constantly (every refresh, every infinite-scroll). For a well-curated
//   account (here: 1129 follows in the crypto industry) the home feed IS
//   already keyword-filtered by the people the user chose to follow.
//   We pull a page (~40 tweets), filter locally for our keywords, push
//   the matches to the reply queue. X never sees what we're "searching"
//   for — it just sees a feed scroll, which is the most common thing on
//   the platform.
//
// Throughput notes (re: 1000-replies/day target):
//   - Cooldown is rolled ONCE per reply (stored in `nextEligibleAt`), not
//     re-rolled on every tick. Re-rolling per-tick was non-monotonic and
//     dropped effective throughput.
//   - HomeTimeline page = ~40 tweets. Even with strict keyword filters
//     5-10 typically match, which feeds the queue ahead of the reply
//     pace easily.
//
// Bridge note: with the Chrome-bridge architecture, `account_id` no longer
// uniquely identifies a session — the extension is global per Chrome
// install, and the connected handle is whichever account is logged into
// x.com in that Chrome. We still keep account_id on campaigns for now, but
// every campaign effectively shares the same upstream session.
import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { XClient } from '../x/client.js';
import { bridge } from '../bridge/server.js';
import { rewriteTemplate, literalSubstitute } from '../persona/persona.js';
import { notifyOwnersDebounced, resetDebounce } from '../core/notify.js';
import { observe as observeTrends } from '../scout/trends.js';

// Per-campaign in-memory state. Rebuilt fresh on process restart — the only
// thing we lose is "next eligible at", which means a freshly-restarted bot
// can fire one reply immediately. That's acceptable; the hourly token-bucket
// in SQLite still bounds it.
const queues = new Map();              // campaign_id → tweet[]
const nextEligibleAt = new Map();      // campaign_id → timestamp ms
const lastScrollEmpty = new Map();     // campaign_id → boolean (true = throttle next scroll)
const sleepLogTickedAt = new Map();    // campaign_id → timestamp ms (rate-limit sleep msgs)
const bridgeWarnedAt = new Map();      // campaign_id → ts (last "bridge offline" warn)
// HomeTimeline cursor for incremental scroll. When nextCursor returns null
// (end of available feed) or a scan returns 0 fresh tweets twice in a row,
// we reset to null and start from the top — same behavior as the X UI's
// pull-to-refresh. We ALSO force a reset every cfg.pacing.cursorRefreshMin
// minutes regardless of feed state, so a constantly-active feed (which
// would never produce two empty pages in a row) still cycles back to the
// top periodically — otherwise we'd permanently scroll into history and
// never see fresh tweets at the top.
const scrollCursor = new Map();        // campaign_id → opaque cursor string
const emptyScrollStreak = new Map();   // campaign_id → count
const cursorResetAt = new Map();       // campaign_id → ts of last forced reset

// Soft-ban detector. Mostly a safety net now that we use HomeTimeline,
// which is the most-used endpoint on x.com — getting 404s from it would
// suggest something more serious than ad-hoc rate-limiting. We still
// detect and back off so a misbehaving bot can't keep hitting a wall.
const consecutive404 = new Map();
const banUntilMs = new Map();
const banLogTickedAt = new Map();

function bumpBan(campaignId) {
  const n = (consecutive404.get(campaignId) || 0) + 1;
  consecutive404.set(campaignId, n);
  if (n < 3) return null;
  const tier = Math.min(Math.floor(n / 3) - 1, 3);
  const minutes = 30 * (2 ** tier);
  const until = Date.now() + minutes * 60_000;
  banUntilMs.set(campaignId, until);
  return minutes;
}

function clearBan(campaignId) {
  consecutive404.delete(campaignId);
  banUntilMs.delete(campaignId);
  banLogTickedAt.delete(campaignId);
}

export function clearSoftBan(campaignId) {
  clearBan(campaignId);
}

// Detect "Operation X not captured yet" errors propagated from the Chrome
// extension via the bridge, and push a one-shot Telegram nag explaining
// the one-time manual fix. Debounced so a stuck campaign hammering the
// same op doesn't carpet-bomb the chat.
//
// Why this matters: the extension learns each X.com GraphQL op shape only
// by observing the *real x.com tab* issuing it. HomeTimeline auto-warmup
// covers itself (we open x.com/home in a hidden tab on bridge connect).
// CreateTweet, however, is a write op — it only fires when a human actually
// posts something. There's no way for us to capture it without the user
// doing one manual tweet. Better to surface that clearly than to keep
// throwing into a logger the user might not be tailing.
function maybeNotifyMissingOp(campaignId, errMessage) {
  const m = /Operation (\w+) not captured yet/.exec(errMessage || '');
  if (!m) return;
  const opName = m[1];
  const key = `op-missing:${opName}`;
  const isWriteOp = opName === 'CreateTweet';
  const text = isWriteOp
    ? `⚠️ Я не могу отвечать пока расширение не поймает шаблон CreateTweet.\n\n` +
      `One-time fix: открой x.com → запости что-нибудь (любой ответ, хоть «gm») → готово.\n` +
      `После этого я подхвачу шаблон автоматически и продолжу через ~5 секунд. ` +
      `Делается раз в несколько недель — обычно X не меняет queryId чаще.`
    : `⚠️ Расширение не поймало шаблон ${opName} (campaign #${campaignId}).\n\n` +
      `Открой x.com и подёргай ленту — page-hook поймает op автоматически.`;
  // 4 hour debounce: if the user does the manual tweet within minutes, we
  // re-arm via resetDebounce in the success path. If they ignore the nag,
  // we re-nag every 4h instead of every 5s.
  notifyOwnersDebounced(key, 4 * 3600_000, text).catch(() => {});
}

// Mirrors maybeNotifyMissingOp: when a reply finally succeeds we know the
// op was captured fine, so a *future* missing-op event should re-arm
// immediately (instead of waiting out a stale 4h debounce). We only need
// this for write ops we already nagged about.
function clearMissingOpDebounce() {
  resetDebounce('op-missing:CreateTweet');
  resetDebounce('op-missing:HomeTimeline');
}

export async function tickCampaign(campaign) {
  const cfg = JSON.parse(campaign.config_json);

  if (!bridge.isConnected()) {
    const last = bridgeWarnedAt.get(campaign.id) || 0;
    if (Date.now() - last > 5 * 60_000) {
      logger.warn('runner', `c${campaign.id} idle: extension bridge not connected`, campaign.id);
      bridgeWarnedAt.set(campaign.id, Date.now());
    }
    return;
  }

  const sleepRemain = inSleepWindow(cfg.sleep);
  if (sleepRemain != null) {
    const last = sleepLogTickedAt.get(campaign.id) || 0;
    if (Date.now() - last > 60_000) {
      logger.info('runner', `c${campaign.id} in sleep window, ${Math.ceil(sleepRemain/60)}min left`, campaign.id);
      sleepLogTickedAt.set(campaign.id, Date.now());
    }
    return;
  }

  const banUntil = banUntilMs.get(campaign.id) || 0;
  if (banUntil && Date.now() < banUntil) {
    const last = banLogTickedAt.get(campaign.id) || 0;
    if (Date.now() - last > 5 * 60_000) {
      const minLeft = Math.ceil((banUntil - Date.now()) / 60_000);
      logger.warn(
        'runner',
        `c${campaign.id} backoff after consecutive 404s — ${minLeft}min left. ` +
        `If x.com works in your browser, /pause then /run to clear.`,
        campaign.id,
      );
      banLogTickedAt.set(campaign.id, Date.now());
    }
    return;
  } else if (banUntil) {
    banUntilMs.delete(campaign.id);
    banLogTickedAt.delete(campaign.id);
    logger.info('runner', `c${campaign.id} resuming after soft-ban backoff`, campaign.id);
  }

  const sentLastHour = db.countSentLastHour(campaign.id);
  if (sentLastHour >= (cfg.pacing.maxRepliesPerHour || 15)) {
    return;
  }

  const eligibleAt = nextEligibleAt.get(campaign.id) || 0;
  if (Date.now() < eligibleAt) return;

  const client = new XClient({ lang: cfg.lang || 'en' });

  // Refill queue from HomeTimeline if empty.
  let queue = queues.get(campaign.id) || [];
  if (queue.length === 0) {
    if (lastScrollEmpty.get(campaign.id)) {
      const sinceScroll = Date.now() - (campaign.last_search_at || 0);
      if (campaign.last_search_at && sinceScroll < (cfg.pacing.searchEverySec || 90) * 1000) return;
    }
    try {
      queue = await runFeedScan(client, campaign, cfg);
      queues.set(campaign.id, queue);
      lastScrollEmpty.set(campaign.id, queue.length === 0);
      db.bumpCampaignAction(campaign.id, 'search');
      logger.info('runner', `c${campaign.id} feed scan → ${queue.length} matches`, campaign.id);
      if (queue.length > 0 && consecutive404.get(campaign.id)) {
        clearBan(campaign.id);
      }
    } catch (e) {
      logger.error('runner', `c${campaign.id} feed scan: ${e.message}`, campaign.id);
      maybeNotifyMissingOp(campaign.id, e.message);
      if (e.code === 'BRIDGE_DISCONNECTED') return;
      if (e.status === 401 || e.status === 403 || e.status === 429) {
        db.setCampaignStatus(campaign.id, 'error', e.message);
      }
      return;
    }
    if (queue.length === 0) return;
  }

  // Pop one and reply. Skip on the fly if:
  //   - the tweet was sent already (race with a parallel campaign or a
  //     prior tick that didn't finish),
  //   - the author is currently on per-author cooldown (multiple tweets
  //     from the same author may sit in the queue together — one feed
  //     page can contain a thread or rapid successive posts),
  //   - or no template matches the tweet's topic AND no catch-all
  //     template was defined. We deliberately drop rather than send an
  //     off-topic reply: a "gm fren" reply to a chart-analysis tweet is
  //     worse than not replying. Users get topic-aware responses by
  //     defining `tags | text` style templates.
  const cooldownMsAuthor = (cfg.pacing.authorCooldownHours ?? 24) * 3600_000;
  let t;
  let tpl;
  while ((t = queue.shift())) {
    queues.set(campaign.id, queue);
    if (db.isSent(campaign.id, t.id)) continue;
    if (cooldownMsAuthor > 0 && t.authorHandle) {
      const lastTs = db.lastAuthorReplyTs(campaign.id, t.authorHandle);
      if (lastTs && Date.now() - lastTs < cooldownMsAuthor) continue;
    }
    tpl = pickTemplate(cfg.templates, t);
    if (!tpl) {
      const who = t.authorHandle ? `@${t.authorHandle}` : '<unknown>';
      logger.info(
        'runner',
        `c${campaign.id} skip ${t.id} (${who}) — no template matched topic`,
        campaign.id,
      );
      continue;
    }
    break;
  }
  if (!t || !tpl) return;
  let text;
  try {
    text = await rewriteTemplate({
      template: tpl.text,
      tweet: t,
      persona: cfg.persona,
    });
  } catch (e) {
    text = literalSubstitute(tpl.text, t);
    logger.warn('runner', `c${campaign.id} AI rewrite failed, using raw template: ${e.message}`, campaign.id);
  }

  const cooldownMs = jitterMs(cfg.pacing.minDelaySec, cfg.pacing.maxDelaySec);
  nextEligibleAt.set(campaign.id, Date.now() + cooldownMs);

  try {
    await client.createTweet({ text, replyToTweetId: t.id });
    db.markSent(campaign.id, t.id);
    if (t.authorHandle) db.markAuthorReplied(campaign.id, t.authorHandle);
    db.bumpCampaignAction(campaign.id, 'reply');
    // Successful reply ⇒ CreateTweet op was captured and works. Clear any
    // outstanding "missing op" debounce so a future regression re-nags
    // immediately instead of waiting 4h.
    clearMissingOpDebounce();
    const who = t.authorHandle ? `@${t.authorHandle}` : '<unknown author>';
    const kw = t._matchedKeyword ? ` [kw="${t._matchedKeyword}"]` : '';
    logger.info('runner', `c${campaign.id} replied to ${who} (${t.id})${kw}`, campaign.id);
  } catch (e) {
    const who = t.authorHandle ? `@${t.authorHandle}` : '<unknown author>';
    logger.error('runner', `c${campaign.id} reply ${t.id} (${who}): ${e.message}`, campaign.id);
    maybeNotifyMissingOp(campaign.id, e.message);
    if (e.code === 'BRIDGE_DISCONNECTED') {
      queue.unshift(t);
      queues.set(campaign.id, queue);
      return;
    }
    db.markSent(campaign.id, t.id);
    if (e.status === 401 || e.status === 403 || e.status === 429) {
      db.setCampaignStatus(campaign.id, 'error', e.message);
    }
  }
}

// Pull one HomeTimeline page (advancing the per-campaign cursor), filter
// locally by cfg.keywords + cfg.filters. Returns the matched tweets.
async function runFeedScan(client, campaign, cfg) {
  // Time-based cursor refresh. The existing 2-empty-pages logic only fires
  // when the feed runs out of fresh tweets to show — but on an active
  // feed we may never see two empty pages in a row, in which case the
  // cursor would crawl ever deeper into history and we'd stop seeing
  // recent tweets. Force a reset every cursorRefreshMin minutes so we
  // cycle: top → deeper → ... → reset → top. Mimics how a real user
  // periodically hits the "show new tweets" banner at the top of the
  // feed.
  const refreshMin = cfg.pacing.cursorRefreshMin ?? 30;
  const lastForced = cursorResetAt.get(campaign.id) || 0;
  if (refreshMin > 0 && Date.now() - lastForced > refreshMin * 60_000) {
    if (scrollCursor.has(campaign.id)) {
      logger.info(
        'runner',
        `c${campaign.id} cursor refresh (every ${refreshMin}min) — fetching fresh top of feed`,
        campaign.id,
      );
    }
    scrollCursor.delete(campaign.id);
    emptyScrollStreak.set(campaign.id, 0);
    cursorResetAt.set(campaign.id, Date.now());
  }

  const cursor = scrollCursor.get(campaign.id) || null;
  let resp;
  try {
    resp = await client.homeTimeline({ cursor, count: 40 });
  } catch (e) {
    if (e.code === 'BRIDGE_DISCONNECTED') throw e;
    if (e.status === 401 || e.status === 403 || e.status === 429) throw e;
    if (e.status === 404) {
      const wait = bumpBan(campaign.id);
      if (wait != null) {
        logger.warn(
          'runner',
          `c${campaign.id} soft-ban backoff: ${wait}min — HomeTimeline 404. ` +
          `Verify x.com works in your browser before /run.`,
          campaign.id,
        );
      }
      throw e;
    }
    throw e;
  }

  // Advance cursor for next call. If the API returned no fresh cursor or
  // we got an empty page twice, reset to top of feed (mimics pull-to-refresh).
  const newCursor = resp.nextCursor;
  if (!resp.tweets || resp.tweets.length === 0) {
    const streak = (emptyScrollStreak.get(campaign.id) || 0) + 1;
    emptyScrollStreak.set(campaign.id, streak);
    if (streak >= 2) {
      scrollCursor.delete(campaign.id);
      emptyScrollStreak.set(campaign.id, 0);
      logger.info('runner', `c${campaign.id} feed exhausted, reset to top`, campaign.id);
    } else if (newCursor) {
      scrollCursor.set(campaign.id, newCursor);
    }
  } else {
    emptyScrollStreak.set(campaign.id, 0);
    if (newCursor) scrollCursor.set(campaign.id, newCursor);
  }

  // Local keyword match. cfg.keywords are now plain substrings (e.g.
  // "solana", "gm crypto"). We treat each entry as a case-insensitive
  // substring match against tweet text. Multi-word entries match if all
  // words appear (in any order) — this lets you say "gm crypto" without
  // it requiring those exact tokens adjacent.
  const keywords = (cfg.keywords || []).map((k) => k.trim()).filter(Boolean);

  // Trend observation hook (PR4). Push the FULL feed page into the
  // trend ledger, not just the keyword-matched subset — the whole
  // point of /trends is to surface what's bubbling that the user
  // hasn't put into their keyword list yet. Fire-and-forget; failures
  // are swallowed inside trends.observe so a hiccup here can't abort
  // a feed scan.
  if (resp.tweets && resp.tweets.length) {
    observeTrends(campaign.id, resp.tweets).catch(() => {});
  }

  const cooldownMsAuthor = (cfg.pacing.authorCooldownHours ?? 24) * 3600_000;
  let droppedNoHandle = 0;
  let droppedNoMatch = 0;
  let droppedAuthorCooldown = 0;
  const passed = [];
  for (const t of resp.tweets || []) {
    if (!t || !t.id || !t.text) continue;
    if (!t.authorHandle) { droppedNoHandle++; continue; }
    const matched = matchKeyword(t.text, keywords);
    if (!matched) { droppedNoMatch++; continue; }
    if (!passesFilters(t, cfg.filters)) continue;
    if (db.isSent(campaign.id, t.id)) continue;
    if (cooldownMsAuthor > 0) {
      const lastTs = db.lastAuthorReplyTs(campaign.id, t.authorHandle);
      if (lastTs && Date.now() - lastTs < cooldownMsAuthor) {
        droppedAuthorCooldown++;
        continue;
      }
    }
    t._matchedKeyword = matched;
    passed.push(t);
  }
  if ((resp.tweets || []).length > 0) {
    const cooldownPart = droppedAuthorCooldown > 0 ? `, ${droppedAuthorCooldown} author-cooldown` : '';
    logger.info(
      'runner',
      `c${campaign.id} feed page: ${resp.tweets.length} tweets, ${passed.length} kw-matched, ` +
      `${droppedNoMatch} no-match, ${droppedNoHandle} no-handle${cooldownPart}`,
      campaign.id,
    );
  }
  return passed;
}

// Match tweet text against the keyword list. Each keyword is a string;
// multi-word entries require all words to appear in text (case-insensitive).
// Returns the matched keyword string or null.
function matchKeyword(text, keywords) {
  if (!keywords || keywords.length === 0) {
    // Empty keyword list = match everything. Useful for "reply to anything
    // in my feed" mode.
    return '*';
  }
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    const tokens = kw.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens.every((tok) => lower.includes(tok))) return kw;
  }
  return null;
}

function passesFilters(t, f) {
  if (!t || !t.id || !t.text) return false;
  if (!t.authorHandle) return false;
  if (f.skipReplies && t.isReply) return false;
  if (f.skipRetweets && t.isRetweet) return false;
  if (f.skipQuotes && t.isQuote) return false;
  if (f.skipWithUrls && t.hasUrls) return false;
  if (f.minLikes && (t.favoriteCount || 0) < f.minLikes) return false;
  if (f.minAuthorFollowers && (t.authorFollowers || 0) < f.minAuthorFollowers) return false;
  if (f.langs?.length && t.lang && !f.langs.includes(t.lang)) return false;
  if (t.createdAt) {
    const ageSec = (Date.now() - new Date(t.createdAt).getTime()) / 1000;
    if (f.minTweetAgeSec && ageSec < f.minTweetAgeSec) return false;
    if (f.maxAgeMinutes && ageSec > f.maxAgeMinutes * 60) return false;
  }
  const handle = (t.authorHandle || '').toLowerCase();
  for (const h of (f.blacklistHandles || [])) {
    if (h && handle === String(h).toLowerCase().replace(/^@/, '')) return false;
  }
  const lower = (t.text || '').toLowerCase();
  for (const w of (f.blacklistWords || [])) {
    if (w && lower.includes(String(w).toLowerCase())) return false;
  }
  return true;
}

// Topic-aware template selection.
//
// Templates can be either:
//   • plain string  (legacy, catch-all — matches any tweet)
//   • { match: string[], text: string }  (canonical)
//
// The shorthand input format the user types in /new is `tags | text`,
// parsed by the Telegram layer into the canonical object form.
//
// Selection rules:
//   1. Normalize all entries; drop malformed ones.
//   2. Split into "matched" (at least one tag substring is present in the
//      tweet text, all tokens of a multi-word tag must be present in any
//      order — same semantics as cfg.keywords) and "catchall" (no tags).
//   3. Prefer matched over catchall. Pick uniformly within the chosen pool.
//   4. If both pools are empty → return null. The runner treats null as
//      "skip this tweet" rather than reply off-topic.
//
// Why "skip" beats "reply off-topic" — a "gm fren" reply to a chart-analysis
// post is worse than not replying. The whole point of topic tags is to keep
// every reply on-topic; randomly picking a catch-all when none was defined
// would defeat that.
function pickTemplate(templates, tweet) {
  if (!Array.isArray(templates) || templates.length === 0) return null;
  const norm = templates.map(toCanonicalTemplate).filter(Boolean);
  if (!norm.length) return null;
  const lower = (tweet?.text || '').toLowerCase();

  const matched = [];
  const catchall = [];
  for (const t of norm) {
    if (!t.match || t.match.length === 0) {
      catchall.push(t);
      continue;
    }
    if (t.match.some((tag) => allTokensPresent(tag, lower))) matched.push(t);
  }
  const pool = matched.length ? matched : catchall;
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function toCanonicalTemplate(entry) {
  if (typeof entry === 'string') {
    const text = entry.trim();
    return text ? { match: [], text } : null;
  }
  if (entry && typeof entry === 'object' && typeof entry.text === 'string' && entry.text.trim()) {
    return {
      match: Array.isArray(entry.match)
        ? entry.match.map((s) => String(s).toLowerCase().trim()).filter(Boolean)
        : [],
      text: entry.text.trim(),
    };
  }
  return null;
}

// Same semantics as runner's matchKeyword: a multi-word tag matches if all
// of its whitespace-split tokens appear in the haystack (case-insensitive,
// any order). Single-word tags reduce to a plain substring check.
function allTokensPresent(tag, lowerHaystack) {
  const tokens = String(tag).toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((tok) => lowerHaystack.includes(tok));
}

// Log-normal jitter: most pauses short, occasional long ones (human-shaped).
function jitterMs(minSec, maxSec) {
  const lo = Math.max(1, minSec | 0);
  const hi = Math.max(lo + 1, maxSec | 0);
  let u1 = Math.random(); if (u1 < 1e-9) u1 = 1e-9;
  const u2 = Math.random();
  const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const mu = Math.log((lo + hi) / 2);
  let v = Math.exp(mu + 0.45 * n);
  if (v < lo) v = lo;
  if (v > hi * 1.5) v = hi;
  return v * 1000;
}

function inSleepWindow(s) {
  if (!s?.enabled) return null;
  const d = new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = parseHHMM(s.startHHMM);
  const end = parseHHMM(s.endHHMM);
  if (start == null || end == null) return null;
  let inside = start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
  if (!inside) return null;
  let mins = start <= end ? end - cur : (cur >= start ? (24 * 60 - cur) + end : end - cur);
  return mins * 60;
}
function parseHHMM(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}
