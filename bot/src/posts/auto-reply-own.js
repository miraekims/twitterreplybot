// Auto-reply to comments on OWN posts.
//
// Why this is the highest-value engagement signal:
//   X's algorithm gives a ×150 weight to "author replies to a commenter
//   on their own post" (vs ×1 for a like). When someone comments on your
//   tweet and you reply, X interprets this as a high-quality conversation
//   and amplifies both your original post AND the thread to more people.
//
// How it works:
//   1. Every 2 minutes, check recent published posts (last 24h) for new
//      comments via TweetDetail.
//   2. For each new comment we haven't replied to yet, generate a
//      contextual AI reply and post it.
//   3. Target: reply within 5 minutes of the comment appearing.
//      The 2-minute polling interval means worst case ~2 min latency,
//      best case immediate on next tick.
//
// Why 24h window: posts older than 24h have already had their algo
// window close. Replying to comments on old posts still works for
// relationship-building but doesn't get the ×150 boost.
//
// Guardrails:
//   - Only reply once per commenter per post (don't spam the thread)
//   - Skip own replies (don't reply to yourself)
//   - Skip very short comments (<10 chars — likely emoji/bot)
//   - Max 3 auto-replies per post (don't dominate your own thread)
//   - Requires OPENAI_API_KEY for AI generation
//   - cfg.autoReplyOwn: true enables (default true)

import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { bridge } from '../bridge/server.js';
import { XClient } from '../x/client.js';
import { rewriteTemplate } from '../persona/persona.js';

const POLL_INTERVAL_MS = 2 * 60 * 1000;       // check every 2 minutes
const POST_WINDOW_MS = 24 * 60 * 60 * 1000;   // monitor posts from last 24h
const MAX_REPLIES_PER_POST = 3;                // don't dominate own thread
const STARTUP_DELAY_MS = 3 * 60 * 1000;       // wait 3 min after boot

// Track which comments we've already replied to (in-memory, reset on restart)
// Key: "postId:commentId" → true
const repliedComments = new Set();

// Track reply count per post to enforce MAX_REPLIES_PER_POST
const replyCountPerPost = new Map(); // posted_tweet_id → count

let _running = false;
let _timer = null;

export function startAutoReplyOwn() {
  if (_running) return;
  _running = true;
  _timer = setTimeout(() => {
    pollLoop();
  }, STARTUP_DELAY_MS);
  logger.info('auto-reply-own', 'auto-reply-to-own-posts monitor started');
}

export function stopAutoReplyOwn() {
  if (_timer) clearTimeout(_timer);
  _timer = null;
  _running = false;
}

function pollLoop() {
  if (!_running) return;
  tick().catch((e) => logger.error('auto-reply-own', `tick: ${e.message}`));
  _timer = setTimeout(pollLoop, POLL_INTERVAL_MS);
}

async function tick() {
  // Pre-checks
  if (!process.env.OPENAI_API_KEY) return;
  if (!bridge.isConnected()) return;

  // Get recent published posts with tweet IDs
  const recentPosts = getRecentPublishedPosts();
  if (!recentPosts.length) return;

  const client = new XClient();

  for (const post of recentPosts) {
    if (!post.posted_tweet_id) continue;

    // Enforce per-post reply cap
    const currentCount = replyCountPerPost.get(post.posted_tweet_id) || 0;
    if (currentCount >= MAX_REPLIES_PER_POST) continue;

    // Get campaign config for persona
    let cfg = {};
    try {
      const campaign = db.getCampaign(post.campaign_id);
      if (campaign) cfg = JSON.parse(campaign.config_json);
    } catch {}

    // Check if auto-reply-own is disabled
    if (cfg.autoReplyOwn === false) continue;

    try {
      const detail = await client.tweetDetail({ tweetId: post.posted_tweet_id });
      const replies = detail.replies || [];

      if (!replies.length) continue;

      // Get the bot's own handle to skip self-replies
      const botHandle = bridge.status()?.handle?.toLowerCase() || '';

      for (const reply of replies) {
        if (!reply.id || !reply.text || !reply.authorHandle) continue;

        // Skip if already replied to this comment
        const key = `${post.posted_tweet_id}:${reply.id}`;
        if (repliedComments.has(key)) continue;

        // Skip own replies
        if (botHandle && reply.authorHandle.toLowerCase() === botHandle) {
          repliedComments.add(key); // mark so we don't check again
          continue;
        }

        // Skip very short comments (emoji, "gm", etc)
        if (reply.text.length < 10) {
          repliedComments.add(key);
          continue;
        }

        // Check per-post cap again (may have incremented during this loop)
        const count = replyCountPerPost.get(post.posted_tweet_id) || 0;
        if (count >= MAX_REPLIES_PER_POST) break;

        // Generate contextual reply
        let text;
        try {
          text = await rewriteTemplate({
            template: 'reply warmly and substantively to this comment on your own post, ' +
                      'continue the conversation naturally, ask a follow-up or add perspective',
            tweet: {
              id: reply.id,
              text: reply.text,
              authorHandle: reply.authorHandle,
              _parentContext: `Your original post: "${post.text}"`,
            },
            persona: cfg.persona,
          });
        } catch (e) {
          logger.warn('auto-reply-own', `AI generation failed: ${e.message}`);
          continue;
        }

        if (!text || text.length > 280) {
          text = text ? text.slice(0, 277) + '...' : null;
          if (!text) continue;
        }

        // Post the reply
        try {
          await client.createTweet({ text, replyToTweetId: reply.id });
          repliedComments.add(key);
          replyCountPerPost.set(post.posted_tweet_id, count + 1);
          logger.info(
            'auto-reply-own',
            `replied to @${reply.authorHandle} on own post ${post.posted_tweet_id} ` +
            `(${count + 1}/${MAX_REPLIES_PER_POST})`,
          );

          // Don't rapid-fire — wait 30-60s between replies in the same thread
          await sleep(30_000 + Math.random() * 30_000);
        } catch (e) {
          logger.error('auto-reply-own', `reply failed: ${e.message}`);
          if (e.code === 'BRIDGE_DISCONNECTED') return; // bail entire tick
          repliedComments.add(key); // don't retry failed ones
        }
      }
    } catch (e) {
      // TweetDetail might fail if post was deleted or restricted
      if (e.status === 404) {
        logger.info('auto-reply-own', `post ${post.posted_tweet_id} not found (deleted?)`);
      } else {
        logger.warn('auto-reply-own', `TweetDetail ${post.posted_tweet_id}: ${e.message}`);
      }
    }
  }
}

/**
 * Get posts published in the last 24h that have a tweet ID.
 * These are the ones we monitor for incoming comments.
 */
function getRecentPublishedPosts() {
  const since = Date.now() - POST_WINDOW_MS;
  try {
    // Query posts table for recently published posts
    const allCampaigns = db.listAllCampaigns();
    const campaignIds = allCampaigns.map((c) => c.id);
    if (!campaignIds.length) return [];

    const posts = [];
    for (const cId of campaignIds) {
      const recent = db.recentPosts(cId, 10);
      for (const p of recent) {
        if (p.status === 'published' && p.posted_tweet_id && p.posted_at >= since) {
          posts.push(p);
        }
      }
    }
    return posts;
  } catch (e) {
    logger.warn('auto-reply-own', `getRecentPublishedPosts: ${e.message}`);
    return [];
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
