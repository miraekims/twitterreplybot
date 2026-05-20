// Best-hours analysis module.
//
// Analyzes engagement data to determine which UTC hours produce the best
// response for each campaign. Used by the activity-shift module to
// concentrate posting during high-engagement windows.
//
// Algorithm:
//   1. Pull engagement-by-hour aggregates for the last 14 days.
//   2. Compute a normalized score per hour (0-1 scale).
//   3. Identify "golden hours" (top 25% by avg engagement score).
//   4. Identify "dead hours" (bottom 25% with enough data).
//   5. Return a 24-slot weight array that the activity shifter uses
//      to bias cooldown durations.
import { db } from '../core/db.js';
import { logger } from '../core/logger.js';

const MIN_SAMPLES_PER_HOUR = 3; // need at least 3 replies in an hour slot to trust it

/**
 * Analyze best posting hours for a campaign.
 * Returns { weights: number[24], goldenHours: number[], deadHours: number[], raw: [...] }
 *
 * weights[h] = 0..2 multiplier:
 *   > 1 = better than average (post more aggressively)
 *   < 1 = worse than average (slow down)
 *   = 1 = no data or average
 */
export function analyzeBestHours(campaign_id, days = 14) {
  const hourData = db.getEngagementByHour(campaign_id, days);

  // Initialize 24 slots
  const weights = new Array(24).fill(1.0);
  const raw = new Array(24).fill(null);

  if (!hourData || hourData.length === 0) {
    return { weights, goldenHours: [], deadHours: [], raw };
  }

  // Map DB results to hour slots
  const scores = new Array(24).fill(0);
  const counts = new Array(24).fill(0);

  for (const row of hourData) {
    const h = row.hour_utc;
    if (h < 0 || h > 23) continue;
    scores[h] = row.avg_score || 0;
    counts[h] = row.count || 0;
    raw[h] = {
      hour: h,
      count: row.count,
      avgScore: Math.round((row.avg_score || 0) * 100) / 100,
      totalLikes: row.total_likes || 0,
      totalRetweets: row.total_retweets || 0,
      totalFollows: row.total_follows || 0,
    };
  }

  // Only consider hours with enough samples
  const validHours = [];
  for (let h = 0; h < 24; h++) {
    if (counts[h] >= MIN_SAMPLES_PER_HOUR) {
      validHours.push({ hour: h, score: scores[h], count: counts[h] });
    }
  }

  if (validHours.length < 4) {
    // Not enough data to draw conclusions
    return { weights, goldenHours: [], deadHours: [], raw };
  }

  // Compute normalized weights
  const avgScore = validHours.reduce((s, v) => s + v.score, 0) / validHours.length;
  if (avgScore <= 0) {
    return { weights, goldenHours: [], deadHours: [], raw };
  }

  for (const v of validHours) {
    // Clamp weight between 0.3 and 2.0
    const w = Math.max(0.3, Math.min(2.0, v.score / avgScore));
    weights[v.hour] = Math.round(w * 100) / 100;
  }

  // Identify golden hours (top 25%) and dead hours (bottom 25%)
  const sorted = [...validHours].sort((a, b) => b.score - a.score);
  const topN = Math.max(1, Math.floor(sorted.length * 0.25));
  const goldenHours = sorted.slice(0, topN).map((v) => v.hour);
  const deadHours = sorted.slice(-topN).map((v) => v.hour);

  logger.info(
    'best-hours',
    `c${campaign_id} analysis: golden=${JSON.stringify(goldenHours)}, dead=${JSON.stringify(deadHours)} (${validHours.length} hours with data)`,
    campaign_id,
  );

  return { weights, goldenHours, deadHours, raw };
}

/**
 * Get a human-readable summary of best hours for API/Telegram.
 */
export function bestHoursSummary(campaign_id) {
  const { goldenHours, deadHours, raw } = analyzeBestHours(campaign_id);

  const formatHour = (h) => `${String(h).padStart(2, '0')}:00 UTC`;
  const golden = goldenHours.map(formatHour).join(', ') || 'not enough data';
  const dead = deadHours.map(formatHour).join(', ') || 'not enough data';

  return {
    goldenHours: golden,
    deadHours: dead,
    rawHours: raw.filter(Boolean),
  };
}
