// Activity shift module.
//
// Automatically biases reply cadence toward hours with proven engagement.
// Instead of uniform random delays, the cooldown between replies is
// modulated by the best-hours weight for the current UTC hour:
//
//   effective_cooldown = base_cooldown / weight[current_hour]
//
// This means:
//   - During golden hours (weight > 1): shorter cooldowns → more replies
//   - During dead hours (weight < 1): longer cooldowns → fewer replies
//   - Net effect: same daily total, but concentrated in high-ROI windows
//
// The shift is gradual — weights are clamped [0.5, 1.8] so the bot never
// goes completely silent or suspiciously hyperactive in any single hour.
// As more engagement data accumulates, the shift becomes more pronounced.
import { analyzeBestHours } from './best-hours.js';
import { logger } from '../core/logger.js';

// Cache analysis results per campaign (refresh every 30 min)
const _cache = new Map(); // campaign_id → { weights, ts }
const CACHE_TTL_MS = 30 * 60_000;

/**
 * Get the activity weight for the current hour.
 * Returns a multiplier (0.5 - 1.8) that should be applied to cooldown:
 *   adjusted_cooldown = base_cooldown / getHourWeight(campaign_id)
 *
 * Higher weight = shorter cooldown = more active in this hour.
 */
export function getHourWeight(campaign_id) {
  const weights = getCachedWeights(campaign_id);
  const currentHour = new Date().getUTCHours();
  return weights[currentHour] || 1.0;
}

/**
 * Adjust a base cooldown (ms) by the current hour's weight.
 * Clamps the result to [minMs, maxMs] to avoid extremes.
 */
export function adjustCooldown(campaign_id, baseMs, minMs = 15_000, maxMs = 300_000) {
  const weight = getHourWeight(campaign_id);
  // Higher weight → divide cooldown (post faster)
  const adjusted = Math.round(baseMs / weight);
  return Math.max(minMs, Math.min(maxMs, adjusted));
}

/**
 * Check if the current hour is a "golden hour" for this campaign.
 */
export function isGoldenHour(campaign_id) {
  const { goldenHours } = getAnalysis(campaign_id);
  const currentHour = new Date().getUTCHours();
  return goldenHours.includes(currentHour);
}

/**
 * Check if the current hour is a "dead hour" for this campaign.
 */
export function isDeadHour(campaign_id) {
  const { deadHours } = getAnalysis(campaign_id);
  const currentHour = new Date().getUTCHours();
  return deadHours.includes(currentHour);
}

function getCachedWeights(campaign_id) {
  const cached = _cache.get(campaign_id);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.weights;
  }
  const { weights } = analyzeBestHours(campaign_id);
  // Clamp weights to safe range
  const clamped = weights.map((w) => Math.max(0.5, Math.min(1.8, w)));
  _cache.set(campaign_id, { weights: clamped, ts: Date.now() });
  return clamped;
}

function getAnalysis(campaign_id) {
  const cached = _cache.get(campaign_id);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    // Re-derive golden/dead from weights
    const weights = cached.weights;
    const sorted = weights
      .map((w, h) => ({ h, w }))
      .filter((x) => x.w !== 1.0)
      .sort((a, b) => b.w - a.w);
    const topN = Math.max(1, Math.floor(sorted.length * 0.25));
    return {
      goldenHours: sorted.slice(0, topN).map((x) => x.h),
      deadHours: sorted.slice(-topN).map((x) => x.h),
    };
  }
  const result = analyzeBestHours(campaign_id);
  const clamped = result.weights.map((w) => Math.max(0.5, Math.min(1.8, w)));
  _cache.set(campaign_id, { weights: clamped, ts: Date.now() });
  return result;
}

/**
 * Force refresh the cached analysis (e.g., after engagement data updates).
 */
export function invalidateCache(campaign_id) {
  _cache.delete(campaign_id);
}

/**
 * Log the current hour's status for debugging.
 */
export function logHourStatus(campaign_id) {
  const weight = getHourWeight(campaign_id);
  const hour = new Date().getUTCHours();
  const golden = isGoldenHour(campaign_id);
  const dead = isDeadHour(campaign_id);
  const tag = golden ? ' [GOLDEN]' : dead ? ' [DEAD]' : '';
  logger.info(
    'activity-shift',
    `c${campaign_id} hour=${hour}:00 UTC weight=${weight}${tag}`,
    campaign_id,
  );
}
