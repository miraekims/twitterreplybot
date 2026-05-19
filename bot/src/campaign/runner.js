// Per-tick campaign logic. Called from the supervisor every 5s for each
// running campaign. At most one X.com action per tick.
//
// Decision tree:
//   1. extension bridge disconnected? → idle (don't burn cooldown)
//   2. sleep window? → bail
//   3. hourly cap reached? → bail
//   4. cooldown since last action not elapsed? → bail
//   5. queue empty + searchEverySec elapsed? → search, refill queue
//   6. queue has items? → reply to next tweet, dedup-mark
//
// Throughput notes (re: 1000-replies/day target):
//   - The supervisor wakes every 5s, so the actual-vs-configured cooldown
//     has up to ~2.5s slop per reply. At 1000/day that's ~42min/day of
//     unrecoverable slop, baked into the math in defaults.js.
//   - Cooldown is rolled ONCE per reply (stored in `nextEligibleAt`), not
//     re-rolled on every tick. Re-rolling per-tick was non-monotonic and
//     dropped effective throughput.
//   - When the queue is empty, we search immediately if the last search was
//     productive. Only when consecutive searches return empty do we fall
//     back to the configured `searchEverySec` throttle.
//
// Bridge note: with the Chrome-bridge architecture, `account_id` no longer
// uniquely identifies a session — the extension is global per Chrome
// install, and the connected handle is whichever account is logged into
// x.com in that Chrome. We still keep account_id on campaigns for now, but
// every campaign effectively shares the same upstream session. Multi-
// account support would need either multiple Chrome profiles or per-handle
// routing through the bridge; explicit non-goal at v0.1.
import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { XClient } from '../x/client.js';
import { bridge } from '../bridge/server.js';
import { rewriteTemplate, literalSubstitute } from '../persona/persona.js';

// Per-campaign in-memory state. Rebuilt fresh on process restart — the only
// thing we lose is "next eligible at", which means a freshly-restarted bot
// can fire one reply immediately. That's acceptable; the hourly token-bucket
// in SQLite still bounds it.
const queues = new Map();              // campaign_id → tweet[]
const nextEligibleAt = new Map();      // campaign_id → timestamp ms
const lastSearchEmpty = new Map();     // campaign_id → boolean (true = throttle)
const sleepLogTickedAt = new Map();    // campaign_id → timestamp ms (rate-limit sleep msgs)
const bridgeWarnedAt = new Map();      // campaign_id → ts (last "bridge offline" warn)
// Cursor pagination state — see runSearchPhase. We persist the bottom
// cursor returned by SearchTimeline per (campaign, keyword) so successive
// phases dig deeper into older results, avoiding the failure mode where
// every search returns the same already-replied top tweets and the queue
// stays empty forever. cursorResetAt tracks when we last cleared cursors;
// when cfg.pacing.cursorRefreshMin elapses, we drop everything and start
// from the top again so fresh tweets aren't missed.
const searchCursors = new Map();       // campaign_id → Map<keyword, cursor>
const cursorResetAt = new Map();       // campaign_id → ts of last cursor reset

export async function tickCampaign(campaign) {
  const cfg = JSON.parse(campaign.config_json);

  // Bridge offline? Idle silently — don't roll cooldowns, don't burn
  // hourly bucket, don't call client. Logging is rate-limited so we don't
  // spam every 5s when Chrome is closed.
  if (!bridge.isConnected()) {
    const last = bridgeWarnedAt.get(campaign.id) || 0;
    if (Date.now() - last > 5 * 60_000) {
      logger.warn('runner', `c${campaign.id} idle: extension bridge not connected`, campaign.id);
      bridgeWarnedAt.set(campaign.id, Date.now());
    }
    return;
  }

  // Sleep window?
  const sleepRemain = inSleepWindow(cfg.sleep);
  if (sleepRemain != null) {
    const last = sleepLogTickedAt.get(campaign.id) || 0;
    if (Date.now() - last > 60_000) {
      logger.info('runner', `c${campaign.id} in sleep window, ${Math.ceil(sleepRemain/60)}min left`, campaign.id);
      sleepLogTickedAt.set(campaign.id, Date.now());
    }
    return;
  }

  // Hourly cap (token bucket)?
  const sentLastHour = db.countSentLastHour(campaign.id);
  if (sentLastHour >= (cfg.pacing.maxRepliesPerHour || 15)) {
    return; // Will be re-checked next tick.
  }

  // Cooldown since last action? Use the eligibility timestamp set after the
  // PREVIOUS reply. If nothing scheduled, we're eligible now.
  const eligibleAt = nextEligibleAt.get(campaign.id) || 0;
  if (Date.now() < eligibleAt) return;

  const client = new XClient({ lang: cfg.lang || 'en' });

  // Search if queue empty.
  let queue = queues.get(campaign.id) || [];
  if (queue.length === 0) {
    if (lastSearchEmpty.get(campaign.id)) {
      const sinceSearch = Date.now() - (campaign.last_search_at || 0);
      if (campaign.last_search_at && sinceSearch < (cfg.pacing.searchEverySec || 180) * 1000) return;
    }
    try {
      queue = await runSearchPhase(client, campaign, cfg);
      queues.set(campaign.id, queue);
      lastSearchEmpty.set(campaign.id, queue.length === 0);
      db.bumpCampaignAction(campaign.id, 'search');
      logger.info('runner', `c${campaign.id} search → ${queue.length} usable`, campaign.id);
    } catch (e) {
      logger.error('runner', `c${campaign.id} search: ${e.message}`, campaign.id);
      // BRIDGE_DISCONNECTED means Chrome went away mid-call. Don't escalate
      // to error status — we'll just retry on the next tick when bridge is
      // back. Auth/rate-limit codes from x.com still hard-stop the
      // campaign so we don't spam into a wall.
      if (e.code === 'BRIDGE_DISCONNECTED') return;
      if (e.status === 401 || e.status === 403 || e.status === 429) {
        db.setCampaignStatus(campaign.id, 'error', e.message);
      }
      return;
    }
    if (queue.length === 0) return;
  }

  // Pop one and reply. Skip on the fly if the tweet was sent already (race
  // between search and reply on a parallel campaign), or if the author is
  // currently on per-author cooldown — multiple tweets from the same
  // author may sit in the queue together, and the cooldown check at search
  // time only excludes authors we'd already replied to BEFORE the search
  // ran.
  const cooldownMsAuthor = (cfg.pacing.authorCooldownHours ?? 24) * 3600_000;
  let t;
  while ((t = queue.shift())) {
    queues.set(campaign.id, queue);
    if (db.isSent(campaign.id, t.id)) continue;
    if (cooldownMsAuthor > 0 && t.authorHandle) {
      const lastTs = db.lastAuthorReplyTs(campaign.id, t.authorHandle);
      if (lastTs && Date.now() - lastTs < cooldownMsAuthor) continue;
    }
    break;
  }
  if (!t) return;

  const tpl = pickTemplate(cfg.templates);
  let text;
  try {
    text = await rewriteTemplate({
      template: tpl,
      tweet: t,
      persona: cfg.persona,
    });
  } catch (e) {
    text = literalSubstitute(tpl, t);
    logger.warn('runner', `c${campaign.id} AI rewrite failed, using raw template: ${e.message}`, campaign.id);
  }

  // Schedule next-eligible BEFORE the network call so a hung call doesn't
  // queue a duplicate on the next tick.
  const cooldownMs = jitterMs(cfg.pacing.minDelaySec, cfg.pacing.maxDelaySec);
  nextEligibleAt.set(campaign.id, Date.now() + cooldownMs);

  try {
    await client.createTweet({ text, replyToTweetId: t.id });
    db.markSent(campaign.id, t.id);
    if (t.authorHandle) db.markAuthorReplied(campaign.id, t.authorHandle);
    db.bumpCampaignAction(campaign.id, 'reply');
    const who = t.authorHandle ? `@${t.authorHandle}` : '<unknown author>';
    logger.info('runner', `c${campaign.id} replied to ${who} (${t.id})`, campaign.id);
  } catch (e) {
    const who = t.authorHandle ? `@${t.authorHandle}` : '<unknown author>';
    logger.error('runner', `c${campaign.id} reply ${t.id} (${who}): ${e.message}`, campaign.id);
    if (e.code === 'BRIDGE_DISCONNECTED') {
      // Don't mark sent — extension never sent the reply. Push the tweet
      // back to the front so the next tick (with bridge restored) tries it.
      queue.unshift(t);
      queues.set(campaign.id, queue);
      return;
    }
    db.markSent(campaign.id, t.id); // don't retry the same broken tweet
    if (e.status === 401 || e.status === 403 || e.status === 429) {
      db.setCampaignStatus(campaign.id, 'error', e.message);
    }
  }
}

async function runSearchPhase(client, campaign, cfg) {
  // Auto-refresh cursors. Every cursorRefreshMin minutes we drop all
  // saved cursors so the next call to SearchTimeline starts at the top of
  // the timeline again. Without this, after enough pagination we'd be
  // permanently stuck reading old tweets and never see fresh ones. With
  // it, we cycle: top → deeper → deeper → ... → reset → top → ...
  const refreshMin = cfg.pacing.cursorRefreshMin ?? 30;
  const lastReset = cursorResetAt.get(campaign.id) || 0;
  if (refreshMin > 0 && Date.now() - lastReset > refreshMin * 60_000) {
    const prev = searchCursors.get(campaign.id);
    if (prev && prev.size > 0) {
      logger.info('runner', `c${campaign.id} cursor reset (every ${refreshMin}min) — fetching fresh top`, campaign.id);
    }
    searchCursors.set(campaign.id, new Map());
    cursorResetAt.set(campaign.id, Date.now());
  }
  let cursors = searchCursors.get(campaign.id);
  if (!cursors) { cursors = new Map(); searchCursors.set(campaign.id, cursors); }

  const all = [];
  const seen = new Set();
  for (const kw of cfg.keywords) {
    try {
      const cursor = cursors.get(kw) || null;
      const res = await client.searchTimeline({ query: kw, cursor });
      const tweets = res.tweets || [];
      const nextCursor = res.nextCursor || null;
      for (const t of tweets) {
        if (!seen.has(t.id)) { seen.add(t.id); all.push({ ...t, _kw: kw }); }
      }
      // If X returned no tweets or no continuation cursor, we hit the
      // bottom of paginatable results. Drop our saved cursor for this
      // keyword so the NEXT search phase starts over from the top instead
      // of repeatedly hitting the same exhausted page.
      if (!tweets.length || !nextCursor) {
        cursors.delete(kw);
      } else {
        cursors.set(kw, nextCursor);
      }
    } catch (e) {
      // Hard errors (bridge down, auth, rate limit) bubble up so the
      // caller can break the loop and decide what to do.
      if (e.code === 'BRIDGE_DISCONNECTED') throw e;
      if (e.status === 401 || e.status === 403 || e.status === 429) throw e;
      logger.warn('runner', `c${campaign.id} search "${kw}": ${e.message}`, campaign.id);
      // Soft error — drop cursor too so we don't get stuck retrying with
      // a bad cursor. Next phase tries fresh top.
      cursors.delete(kw);
    }
    await sleep(800 + Math.random() * 800);
  }

  // Filter — track drops for diagnostics. If a non-trivial fraction of
  // tweets is dropped solely for missing authorHandle, that's our canary
  // for X having silently changed the user-result shape again.
  let droppedNoHandle = 0;
  let droppedAuthorCooldown = 0;
  const cooldownMsAuthor = (cfg.pacing.authorCooldownHours ?? 24) * 3600_000;
  const passed = [];
  for (const t of all) {
    if (!t || !t.id || !t.text) continue;
    if (!t.authorHandle) { droppedNoHandle++; continue; }
    if (!passesFilters(t, cfg.filters)) continue;
    if (db.isSent(campaign.id, t.id)) continue;
    if (cooldownMsAuthor > 0) {
      const lastTs = db.lastAuthorReplyTs(campaign.id, t.authorHandle);
      if (lastTs && Date.now() - lastTs < cooldownMsAuthor) {
        droppedAuthorCooldown++;
        continue;
      }
    }
    passed.push(t);
  }
  if (droppedNoHandle > 0 && all.length > 0) {
    const pct = Math.round((droppedNoHandle / all.length) * 100);
    const fn = pct > 30 ? 'warn' : 'info';
    logger[fn](
      'runner',
      `c${campaign.id} dropped ${droppedNoHandle}/${all.length} tweets with no handle (${pct}%)`,
      campaign.id,
    );
  }
  if (droppedAuthorCooldown > 0) {
    logger.info(
      'runner',
      `c${campaign.id} dropped ${droppedAuthorCooldown} tweets on per-author cooldown`,
      campaign.id,
    );
  }
  return passed;
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

function pickTemplate(templates) {
  return templates[Math.floor(Math.random() * templates.length)];
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
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
