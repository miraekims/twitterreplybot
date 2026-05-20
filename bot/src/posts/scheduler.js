// Auto-post scheduler + publisher loop.
//
// Two responsibilities, separated for clarity:
//
//   1. nextSlotAt(cfg)   — given a campaign config, return a future
//                          timestamp at which the NEXT post should fire.
//                          Honors:
//                            - irregular spacing (random in 30min-4h)
//                            - sleep window (defers slot past wake time)
//                            - daily cap (returns null if cap reached
//                              for today; caller surfaces as queue-full)
//
//   2. startPostsRunner() — the polling loop. Every 30 sec, looks for
//                          posts where status='scheduled' AND
//                          scheduled_at <= now. For each, publishes via
//                          the X client (createTweet without
//                          replyToTweetId = top-level post), updates
//                          row to 'published' or 'failed'.
//
// Design note: we deliberately don't try to be smart about "best time
// to post" — research is contradictory and the stakes don't justify
// optimization. Random irregular spacing + sleep window beats both
// "fixed cron times" (looks botty) AND "ML-optimized timing" (wastes
// engineering budget for ~5% lift).

import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { XClient } from '../x/client.js';
import { bridge } from '../bridge/server.js';
import { notifyOwners } from './notify-bridge.js';

// Tunable. Below these hard limits we're going to look fishy.
const MIN_GAP_MS = 30 * 60 * 1000;       // 30 min minimum between posts
const MAX_GAP_MS = 4 * 60 * 60 * 1000;   // 4 hours maximum
const TICK_INTERVAL_MS = 30_000;          // poll every 30 sec

/**
 * Compute the timestamp for the next post slot for a campaign.
 *
 * @param {object} cfg     The campaign's config_json (parsed).
 * @returns {number|null}  Unix ms of the next slot, or null if today's
 *                         daily cap is reached (caller decides whether
 *                         to silently queue for tomorrow or surface to
 *                         the user as queue-full).
 *
 * Algorithm:
 *   1. Start from the latest of (now, last scheduled post time).
 *      Reading from DB lets us stack slots ahead consistently when the
 *      user fires off /draft three times back-to-back.
 *   2. Add a random gap in [MIN_GAP_MS, MAX_GAP_MS].
 *   3. If the resulting slot falls inside the configured sleep window,
 *      shift it to wake-time + a small random offset (up to 30min).
 *   4. Reject if today's published+scheduled count for this campaign
 *      exceeds posts.maxPerDay (default 6).
 */
export function nextSlotAt(cfg) {
  const now = Date.now();
  const dailyCap = cfg?.posts?.maxPerDay ?? 6;

  // Look up latest scheduled/published post time across last 24h to
  // both stack ahead AND cap-check.
  const dayAgo = now - 24 * 3600 * 1000;
  const recent = db.recentPostsForCap(cfg.__campaignId, dayAgo);
  const todayCount = recent.length;
  if (todayCount >= dailyCap) {
    return null;
  }
  const lastScheduledAt = recent.length
    ? Math.max(...recent.map((r) => r.scheduled_at || r.posted_at || 0))
    : 0;

  const baseTs = Math.max(now, lastScheduledAt);
  const gap = MIN_GAP_MS + Math.floor(Math.random() * (MAX_GAP_MS - MIN_GAP_MS));
  let candidate = baseTs + gap;

  // Sleep-window shift. Same shape as runner.js — 'HH:MM' local time
  // window during which we shouldn't act.
  const sleep = cfg?.sleep;
  if (sleep?.enabled) {
    candidate = shiftPastSleepWindow(candidate, sleep.startHHMM, sleep.endHHMM);
  }
  return candidate;
}

/**
 * If `ts` falls inside [start, end] in local time today (or wrapping
 * across midnight), shift forward to `end` + small random jitter so we
 * don't all post at exactly 08:00.
 */
function shiftPastSleepWindow(ts, startHHMM, endHHMM) {
  const d = new Date(ts);
  const localMins = d.getHours() * 60 + d.getMinutes();
  const startMins = hhmmToMin(startHHMM);
  const endMins = hhmmToMin(endHHMM);

  let inWindow = false;
  if (startMins < endMins) {
    inWindow = localMins >= startMins && localMins < endMins;
  } else {
    // Window wraps midnight, e.g. 23:00 → 07:00.
    inWindow = localMins >= startMins || localMins < endMins;
  }
  if (!inWindow) return ts;

  // Set time to wake-time today (or tomorrow if window wraps).
  const wake = new Date(d);
  wake.setHours(Math.floor(endMins / 60), endMins % 60, 0, 0);
  if (startMins > endMins && localMins >= startMins) {
    // We're after midnight in a wrapping window — wake is today.
    // Otherwise it's tomorrow — already today by setHours, no-op.
  }
  if (wake.getTime() <= ts) {
    // Wake is "earlier today" but we're past it — shift to tomorrow
    // morning. This branch only fires for misaligned configs.
    wake.setDate(wake.getDate() + 1);
  }
  return wake.getTime() + Math.floor(Math.random() * 30 * 60 * 1000);
}

function hhmmToMin(s) {
  const [h, m] = String(s || '00:00').split(':').map((n) => +n);
  return (h || 0) * 60 + (m || 0);
}

// ---------- runner loop ----------

let _running = false;

/**
 * Start the auto-post publishing loop. Idempotent — calling twice has no
 * effect. Designed to share the bridge with the campaign runner; if the
 * Chrome extension is offline we simply skip the tick (no point retrying
 * in 30s if bridge is down for an hour, but the cost of the empty tick
 * is negligible).
 */
export function startPostsRunner() {
  if (_running) return;
  _running = true;
  setInterval(() => {
    tick().catch((e) => logger.error('posts', `runner tick: ${e.message}`));
  }, TICK_INTERVAL_MS);
  logger.info('posts', `auto-post runner started (tick=${TICK_INTERVAL_MS / 1000}s)`);
}

async function tick() {
  if (!bridge.isConnected()) return; // wait for Chrome — same policy as runner.js
  const due = db.duePosts(Date.now());
  if (due.length === 0) return;

  const client = new XClient();
  for (const p of due) {
    try {
      const res = await client.createTweet({ text: p.text });
      // X's CreateTweet response nests the ID deep in the response.
      // Try multiple paths to find it robustly.
      const tweetId = res?.data?.create_tweet?.tweet_results?.result?.rest_id
        || res?.tweetId || res?.id
        || extractTweetIdFromResponse(res)
        || null;
      db.markPostPublished(p.id, tweetId);
      logger.info('posts', `c${p.campaign_id} post ${p.id} → published as ${tweetId || '?'}`);
      // Surface to the user — they specifically asked for posts and
      // should know when they go out, especially with irregular
      // scheduling.
      await notifyOwners(
        `📝 Posted (campaign #${p.campaign_id}):\n\n${p.text}`,
        { campaignId: p.campaign_id },
      ).catch(() => {});
    } catch (e) {
      const msg = e?.message || String(e);
      db.markPostFailed(p.id, msg.slice(0, 200));
      logger.error('posts', `c${p.campaign_id} post ${p.id} failed: ${msg}`);
      // If bridge dropped mid-post, leave 'failed' but the user can
      // retry via /post or by re-running /draft.
    }
  }
}



// Walk the CreateTweet response to find rest_id. X nests it differently
// depending on the version of the frontend that captured the op shape.
function extractTweetIdFromResponse(res) {
  if (!res || typeof res !== 'object') return null;
  const stack = [res];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { for (const c of node) stack.push(c); continue; }
    // The published tweet's rest_id is the one we want
    if (node.rest_id && node.legacy?.full_text) return node.rest_id;
    for (const k of Object.keys(node)) stack.push(node[k]);
  }
  return null;
}
