// Engagement tracking module.
//
// Responsibilities:
//   1. Record every sent reply in reply_engagement (called from runner on success)
//   2. Periodically check engagement metrics for recent replies via X API
//   3. Update scores and propagate to template_stats
//
// The checker runs on a 10-minute interval per active campaign. It fetches
// tweet metrics for replies sent in the last 24h that haven't been checked
// recently. X exposes likes/retweets/reply_count on TweetDetail — we use
// the bridge to fetch those.
import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { XClient } from '../x/client.js';
import { bridge } from '../bridge/server.js';
import { hashTemplate } from './template-hash.js';

const CHECK_INTERVAL_MS = 10 * 60_000; // 10 min
let _interval = null;

/**
 * Record a sent reply for engagement tracking.
 * Called immediately after a successful CreateTweet in the runner.
 */
export function trackReply({ campaign_id, reply_id, tweet_id, template, ai_quality_score }) {
  const template_hash = template ? hashTemplate(template) : null;
  const sent_at = Date.now();

  db.insertReplyEngagement({
    campaign_id,
    reply_id,
    tweet_id,
    template_hash,
    ai_quality_score: ai_quality_score || null,
    sent_at,
  });

  // Bump template usage counter
  if (template_hash) {
    db.bumpTemplateUse(campaign_id, template_hash);
  }

  logger.info('engagement', `c${campaign_id} tracked reply ${reply_id} (quality=${ai_quality_score || '?'})`, campaign_id);
}

/**
 * Start the periodic engagement checker.
 */
export function startEngagementChecker() {
  if (_interval) return;
  _interval = setInterval(checkAllCampaigns, CHECK_INTERVAL_MS);
  // First check after 2 minutes (let things warm up)
  setTimeout(checkAllCampaigns, 2 * 60_000);
  logger.info('engagement', 'engagement checker started (interval=10min)');
}

async function checkAllCampaigns() {
  if (!bridge.isConnected()) return;

  const campaigns = db.campaignsActive();
  for (const c of campaigns) {
    try {
      await checkCampaignEngagement(c);
    } catch (e) {
      logger.error('engagement', `c${c.id} check failed: ${e.message}`, c.id);
    }
  }
}

async function checkCampaignEngagement(campaign) {
  const unchecked = db.getUncheckedReplies(campaign.id, 20);
  if (!unchecked.length) return;

  const client = new XClient({ lang: 'en' });
  let checked = 0;

  for (const row of unchecked) {
    try {
      // Fetch tweet metrics for our reply
      const metrics = await client.getTweetMetrics(row.reply_id);
      if (!metrics) continue;

      const score = db.updateReplyEngagement(row.reply_id, {
        likes: metrics.favorite_count || 0,
        retweets: metrics.retweet_count || 0,
        replies: metrics.reply_count || 0,
        follow_back: metrics.follow_back ? 1 : 0,
      });

      // Propagate score to template stats
      const engagement = db.getEngagementRow?.(row.reply_id);
      if (engagement?.template_hash) {
        db.addTemplateEngagement(campaign.id, engagement.template_hash, score);
      }

      checked++;
    } catch (e) {
      // Don't break the loop on individual failures
      if (e.code === 'BRIDGE_DISCONNECTED') break;
      logger.warn('engagement', `c${campaign.id} metrics fetch ${row.reply_id}: ${e.message}`, campaign.id);
    }

    // Small delay between API calls to avoid rate limiting
    await sleep(2000);
  }

  if (checked > 0) {
    logger.info('engagement', `c${campaign.id} checked ${checked}/${unchecked.length} replies`, campaign.id);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
