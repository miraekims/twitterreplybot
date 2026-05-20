// Auto-draft scheduler. Generates feed-aware posts on a timer and
// schedules them for publishing without manual /draft approval.
//
// Why auto-draft exists:
//   Accounts that only reply get flagged as spam. X's algorithm rewards
//   accounts with a healthy reply:original ratio. 3-6 original posts/day
//   is the minimum to look like a real person (and to give the algo
//   something to distribute to your followers).
//
// How it works:
//   - A cron-like timer fires every 2-4 hours (randomized to avoid
//     pattern detection).
//   - Pulls current feed context (trending topics from the runner's
//     feed snapshot).
//   - Generates 1 post via the same AI pipeline as /draft.
//   - Schedules it for the next available slot (respects daily cap,
//     sleep window, and minimum inter-post gap).
//   - Notifies the user in Telegram so they know what went out.
//
// Guardrails:
//   - Daily cap: 6 posts max (configurable via cfg.posts.maxPerDay).
//   - Sleep window: no posts during configured sleep hours.
//   - Bridge must be connected (need Chrome for publishing).
//   - OPENAI_API_KEY must be set (no AI = no generation).
//   - User can disable via /settings or cfg.autoDraft = false.
//
// The user can always override by:
//   - Using /draft for manual generation with topic choice
//   - Using /post for immediate publishing of own text
//   - Cancelling queued auto-drafts via /queue → Cancel

import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { bridge } from '../bridge/server.js';
import { generateDrafts } from './draft.js';
import { nextSlotAt } from './scheduler.js';
import { notifyOwners } from './notify-bridge.js';
import { getRecentFeedSample } from '../campaign/runner.js';

// Timer config. We randomize the interval so the bot doesn't post at
// exactly 2h intervals (which looks like a cron job to X's heuristics).
// Peak hours bias: posts published 9-11 AM and 5-7 PM get 2-3x more
// initial engagement (verified accounts benefit even more).
const MIN_INTERVAL_MS = 2 * 60 * 60 * 1000;   // 2 hours minimum
const MAX_INTERVAL_MS = 4 * 60 * 60 * 1000;   // 4 hours maximum
const STARTUP_DELAY_MS = 5 * 60 * 1000;       // wait 5 min after boot
const PEAK_HOURS = [9, 10, 11, 17, 18, 19];   // local hours with highest engagement

let _running = false;
let _timer = null;

/**
 * Start the auto-draft scheduler. Idempotent.
 * Runs alongside the posts-runner (which handles publishing).
 */
export function startAutoDraft() {
  if (_running) return;
  _running = true;
  // First tick after startup delay (let feed populate first)
  _timer = setTimeout(() => {
    runAutoDraftCycle();
    scheduleNext();
  }, STARTUP_DELAY_MS);
  logger.info('auto-draft', 'auto-draft scheduler started');
}

export function stopAutoDraft() {
  if (_timer) clearTimeout(_timer);
  _timer = null;
  _running = false;
  logger.info('auto-draft', 'auto-draft scheduler stopped');
}

function scheduleNext() {
  if (!_running) return;
  const gap = MIN_INTERVAL_MS + Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS));
  _timer = setTimeout(() => {
    runAutoDraftCycle();
    scheduleNext();
  }, gap);
  const nextMin = Math.round(gap / 60_000);
  logger.info('auto-draft', `next auto-draft in ${nextMin}min`);
}

/**
 * One cycle: pick a campaign, generate a post, schedule it.
 */
async function runAutoDraftCycle() {
  try {
    // Pre-checks
    if (!process.env.OPENAI_API_KEY) {
      logger.info('auto-draft', 'skip — no OPENAI_API_KEY set');
      return;
    }
    if (!bridge.isConnected()) {
      logger.info('auto-draft', 'skip — bridge not connected');
      return;
    }

    // Find a campaign to post for. Pick the first running campaign,
    // or the most recently active one.
    const campaigns = db.listAllCampaigns ? db.listAllCampaigns() : [];
    if (!campaigns.length) {
      logger.info('auto-draft', 'skip — no campaigns exist');
      return;
    }

    const running = campaigns.filter((c) => c.status === 'running');
    const target = running.length ? running[0] : campaigns[0];

    let cfg = {};
    try { cfg = JSON.parse(target.config_json); } catch {}

    // Check if auto-draft is disabled for this campaign
    if (cfg.autoDraft === false) {
      logger.info('auto-draft', `skip — c${target.id} has autoDraft disabled`);
      return;
    }

    // Check daily cap — use peak hours scheduling for better engagement
    cfg.__campaignId = target.id;
    let slot = nextSlotAt(cfg);
    if (slot == null) {
      logger.info('auto-draft', `skip — c${target.id} daily post cap reached`);
      return;
    }

    // Peak hours optimization: if the slot falls outside peak hours,
    // try to shift it to the nearest peak window (only if within 2h).
    // This gives posts the best initial engagement velocity.
    slot = optimizeForPeakHours(slot);

    // Generate topic from feed context
    const topic = generateTopicFromFeed();
    if (!topic) {
      logger.info('auto-draft', 'skip — no feed data for topic generation');
      return;
    }

    // Generate 1 candidate
    const candidates = await generateDrafts({
      topic,
      persona: cfg.persona,
      count: 1,
    });

    if (!candidates || !candidates.length) {
      logger.warn('auto-draft', 'generation returned no candidates');
      return;
    }

    const text = candidates[0];

    // Schedule the post
    const postId = db.insertScheduledPost({
      campaign_id: target.id,
      text,
      scheduled_at: slot,
      topic,
    });

    const whenStr = new Date(slot).toISOString().slice(0, 16).replace('T', ' ');
    logger.info('auto-draft', `c${target.id} auto-drafted post #${postId} → scheduled ${whenStr} UTC`);

    // Notify user
    await notifyOwners(
      `🤖 Auto-draft (c#${target.id}):\n\n` +
      `${text}\n\n` +
      `⏰ Scheduled: ${whenStr} UTC\n` +
      `Topic: "${topic}"\n\n` +
      `Cancel: /queue → tap ❌`,
      { campaignId: target.id },
    ).catch(() => {});

  } catch (e) {
    logger.error('auto-draft', `cycle failed: ${e.message}`);
  }
}

/**
 * Extract a topic from recent feed data. Picks the most-discussed theme
 * by looking at high-engagement tweets and synthesizing a topic seed.
 */
function generateTopicFromFeed() {
  const sample = getRecentFeedSample(10);
  if (!sample.length) return null;

  // Take the top 3 most-liked tweets and extract key phrases
  const top = sample.slice(0, 3);
  const snippets = top.map((t) => {
    // Clean up: remove URLs, @mentions at start, trim
    return t.text
      .replace(/https?:\/\/\S+/g, '')
      .replace(/^@\w+\s*/g, '')
      .replace(/\n/g, ' ')
      .trim()
      .slice(0, 80);
  }).filter((s) => s.length > 10);

  if (!snippets.length) return null;

  // Use the snippets as a combined topic seed. The AI prompt in draft.js
  // will see the full feed context anyway — this just seeds the direction.
  // Pick the single most engaging topic or combine if they're related.
  return snippets[0]; // Simplest: use the highest-engagement tweet's text as seed
}



/**
 * If a scheduled time falls outside peak hours, shift it to the nearest
 * peak window — but only if the shift is ≤2h. Don't delay too much;
 * regularity matters more than perfection.
 *
 * Peak hours (local): 9-11 AM, 5-7 PM — when CT is most active and
 * the algo's 30-min engagement window has the most potential viewers.
 */
function optimizeForPeakHours(slotMs) {
  const d = new Date(slotMs);
  const hour = d.getHours();

  // Already in peak? Great, no change.
  if (PEAK_HOURS.includes(hour)) return slotMs;

  // Find nearest peak hour
  let nearestDiff = Infinity;
  let nearestHour = hour;
  for (const ph of PEAK_HOURS) {
    let diff = ph - hour;
    if (diff < 0) diff += 24;
    if (diff < nearestDiff) {
      nearestDiff = diff;
      nearestHour = ph;
    }
  }

  // Only shift if within 2 hours — don't delay posts too much
  if (nearestDiff > 2) return slotMs;

  // Shift to the peak hour + random minutes (don't all land at :00)
  const shifted = new Date(d);
  shifted.setHours(nearestHour, Math.floor(Math.random() * 45) + 5, 0, 0);
  // Make sure we didn't go backwards
  if (shifted.getTime() <= Date.now()) return slotMs;
  return shifted.getTime();
}
