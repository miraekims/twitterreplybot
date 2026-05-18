// Per-tick campaign logic. Called from the supervisor every 5s for each
// running campaign. At most one X.com action per tick.
//
// Decision tree:
//   1. sleep window? → bail
//   2. hourly cap reached? → bail
//   3. cooldown since last action not elapsed? → bail
//   4. queue empty + searchEverySec elapsed? → search, refill queue
//   5. queue has items? → reply to next tweet, dedup-mark
//
// Throughput notes (re: 1000-replies/day target):
//   - The supervisor wakes every 5s, so the actual-vs-configured cooldown
//     has up to ~2.5s slop per reply. At 1000/day that's ~42min/day of
//     unrecoverable slop, baked into the math in defaults.js.
//   - Cooldown is rolled ONCE per reply (stored in `nextEligibleAt`), not
//     re-rolled on every tick. The previous version re-rolled per tick,
//     which made the gate non-monotonic and reduced effective throughput
//     because long rolls early in the window kept resetting the wait.
//   - When the queue is empty, we search immediately if the last search
//     was productive. Only when consecutive searches return empty do we
//     fall back to the configured `searchEverySec` throttle. That avoids
//     idling for 2 minutes with bandwidth still on the table.
import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { decryptJSON } from '../core/crypto.js';
import { XClient } from '../x/client.js';
import { capturedOps } from '../x/captured-ops.js';
import { rewriteTemplate, literalSubstitute } from '../persona/persona.js';

const PASSPHRASE = process.env.ENCRYPTION_PASSPHRASE;

// Per-campaign in-memory state. Rebuilt fresh on process restart — the only
// thing we lose is "next eligible at", which means a freshly-restarted bot
// can fire one reply immediately. That's acceptable; the hourly token-bucket
// in SQLite still bounds it.
const queues = new Map();              // campaign_id → tweet[]
const nextEligibleAt = new Map();      // campaign_id → timestamp ms
const lastSearchEmpty = new Map();     // campaign_id → boolean (true = throttle)
const sleepLogTickedAt = new Map();    // campaign_id → timestamp ms (rate-limit sleep msgs)

export async function tickCampaign(campaign) {
  const cfg = JSON.parse(campaign.config_json);
  const acct = db.getAccount(campaign.account_id);
  if (!acct) { db.setCampaignStatus(campaign.id, 'error', 'account missing'); return; }

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
  // PREVIOUS reply. If nothing scheduled (process just started, or never
  // replied), we're eligible now.
  const eligibleAt = nextEligibleAt.get(campaign.id) || 0;
  if (Date.now() < eligibleAt) return;

  let client;
  try {
    const secrets = decryptJSON(PASSPHRASE, acct.secrets_blob);
    client = new XClient({ secrets, proxy: acct.proxy || null, lang: cfg.lang || 'en' });
  } catch (e) {
    db.setCampaignStatus(campaign.id, 'error', `decrypt failed: ${e.message}`);
    logger.error('runner', `c${campaign.id} decrypt: ${e.message}`, campaign.id);
    return;
  }

  // Search if queue empty.
  let queue = queues.get(campaign.id) || [];
  if (queue.length === 0) {
    // Throttle search ONLY if the previous search came back empty. If the
    // last search produced tweets, the queue draining means we found
    // engagement and should refill immediately. That's the difference
    // between 1000/day and ~600/day.
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
      if (e.status === 401 || e.status === 403 || e.status === 429) {
        db.setCampaignStatus(campaign.id, 'error', e.message);
      }
      return;
    }
    if (queue.length === 0) return;
  }

  // Pop one and reply.
  const t = queue.shift();
  queues.set(campaign.id, queue);
  if (db.isSent(campaign.id, t.id)) return;

  const tpl = pickTemplate(cfg.templates);
  let text;
  try {
    text = await rewriteTemplate({
      template: tpl,
      tweet: t,
      persona: cfg.persona,
    });
  } catch (e) {
    // AI configured but failed (timeout, rate-limit, etc). Fall back to
    // literal substitution rather than skip — half a reply is better than
    // none for a campaign at scale, and the next reply will retry the API.
    text = literalSubstitute(tpl, t);
    logger.warn('runner', `c${campaign.id} AI rewrite failed, using raw template: ${e.message}`, campaign.id);
  }

  // Schedule next-eligible BEFORE the network call. If the call hangs we
  // still won't fire again immediately on the next tick. Roll the cooldown
  // here so it's stable across ticks (vs. re-rolling and getting lucky/
  // unlucky on each one).
  const cooldownMs = jitterMs(cfg.pacing.minDelaySec, cfg.pacing.maxDelaySec);
  nextEligibleAt.set(campaign.id, Date.now() + cooldownMs);

  try {
    await client.createTweet({
      capturedOp: capturedOps.CreateTweet,
      text,
      replyToTweetId: t.id,
    });
    db.markSent(campaign.id, t.id);
    db.bumpCampaignAction(campaign.id, 'reply');
    const who = t.authorHandle ? `@${t.authorHandle}` : '<unknown author>';
    logger.info('runner', `c${campaign.id} replied to ${who} (${t.id})`, campaign.id);
  } catch (e) {
    const who = t.authorHandle ? `@${t.authorHandle}` : '<unknown author>';
    logger.error('runner', `c${campaign.id} reply ${t.id} (${who}): ${e.message}`, campaign.id);
    db.markSent(campaign.id, t.id); // don't retry the same broken tweet
    if (e.status === 401 || e.status === 403 || e.status === 429) {
      db.setCampaignStatus(campaign.id, 'error', e.message);
    }
  }
}

async function runSearchPhase(client, campaign, cfg) {
  if (!capturedOps.SearchTimeline) {
    throw new Error('SearchTimeline shape not captured. See bot/src/x/captured-ops.js');
  }
  const all = [];
  const seen = new Set();
  for (const kw of cfg.keywords) {
    try {
      const { tweets } = await client.searchTimeline({
        capturedOp: capturedOps.SearchTimeline,
        query: kw,
      });
      for (const t of tweets) {
        if (!seen.has(t.id)) { seen.add(t.id); all.push({ ...t, _kw: kw }); }
      }
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 429) throw e;
      logger.warn('runner', `c${campaign.id} search "${kw}": ${e.message}`, campaign.id);
    }
    await sleep(800 + Math.random() * 800);
  }

  // Filter — track drops for diagnostics. If a non-trivial fraction of
  // tweets is dropped solely for missing authorHandle, that's our canary
  // for X having silently changed the user-result shape again. See
  // x/client.js extractTweets() for the resolution logic. Without this
  // count the symptom would just be "search → 0 usable" on every cycle.
  let droppedNoHandle = 0;
  const passed = [];
  for (const t of all) {
    if (!t || !t.id || !t.text) continue;
    if (!t.authorHandle) { droppedNoHandle++; continue; }
    if (!passesFilters(t, cfg.filters)) continue;
    if (db.isSent(campaign.id, t.id)) continue;
    passed.push(t);
  }
  if (droppedNoHandle > 0 && all.length > 0) {
    const pct = Math.round((droppedNoHandle / all.length) * 100);
    // Above ~30% suggests a shape change rather than a long-tail of
    // protected/anonymous accounts. Surface as WARN so it shows up in
    // /logs and `docker logs --tail` without grepping.
    const fn = pct > 30 ? 'warn' : 'info';
    logger[fn](
      'runner',
      `c${campaign.id} dropped ${droppedNoHandle}/${all.length} tweets with no handle (${pct}%)`,
      campaign.id,
    );
  }
  return passed;
}

function passesFilters(t, f) {
  if (!t || !t.id || !t.text) return false;
  // Drop tweets where we couldn't resolve the author. With no handle the
  // template can't render `@{author}` and the log line becomes "@null …",
  // which is what was happening before extractTweets handled the new
  // result.core.screen_name shape. Cheap belt-and-suspenders.
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
