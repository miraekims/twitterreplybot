// Campaign config presets.
//
// Three named profiles, all using the same shape so they can be applied
// hot-swap to an existing campaign (Telegram: /preset <id> <name>):
//
//   safe       — fresh accounts, week 1.  Cap 10/h ≈ 170/day.
//   medium     — warmed-up accounts, week 2-4.  Cap 30/h ≈ 510/day.
//   highvolume — battle-tested accounts only.  Cap 70/h ≈ 1000/day.
//                (Goal: ~59/h sustained across 17 active hours.)
//
// We deliberately keep keywords/templates/persona OUT of presets — those are
// per-campaign user content, not pacing knobs. /preset only swaps pacing,
// filters and sleep window.
//
// WARNING on highvolume: per the prior project's notes, sustained >50/h on
// a single account is a fast track to shadowban or outright suspension.
// Use only on accounts older than ~30 days with normal-looking history,
// behind a residential proxy, with a real persona. The bot will not stop
// you, but you've been warned.

const baseFilters = () => ({
  // Note: with HomeTimeline-based feed scanning, these filters apply on
  // top of whatever the user's follow graph already pre-selected. With a
  // well-curated account, defaults can be much looser than they used to
  // be when we were hitting wide-open SearchTimeline.
  //
  // ENGAGEMENT RATE STRATEGY: We set minLikes=2 by default so the bot
  // only replies to tweets that already have SOME social proof. Tweets
  // with 0 likes are either brand new (nobody sees our reply) or simply
  // uninteresting (replying won't get engagement). This single filter
  // dramatically improves engagement rate by ensuring we reply where
  // people are actually reading.
  minLikes: 2,
  minTweetAgeSec: 60,       // give X a moment to surface engagement
  maxAgeMinutes: 120,       // 2 hours — fresher tweets get more visibility
  minAuthorFollowers: 50,   // skip accounts with <50 followers (low visibility)
  langs: ['en'],
  skipReplies: true,
  skipRetweets: true,
  skipQuotes: false,
  skipWithUrls: false,
  blacklistWords: [],
  blacklistHandles: [],
  // Whale niche filter: only drill into posts from whales whose bio OR
  // post text contains at least one of these keywords. Empty = no filter
  // (all whales pass). Default: crypto-related terms.
  whaleNicheKeywords: [
    'crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol',
    'defi', 'web3', 'nft', 'blockchain', 'trading', 'trader',
    'degen', 'altcoin', 'memecoin', 'onchain', 'airdrop',
  ],
});

// Sleep is OFF by default. The user can enable it via /preset or by
// editing config_json directly. We used to default it on (01:00-08:00)
// "for safety", but a 24/7 schedule is fine when paced correctly and
// matches the user's actual usage pattern (X is global; people scroll
// at all hours).
const baseSleep = () => ({
  enabled: false,
  startHHMM: '01:00',
  endHHMM: '08:00',
});

export const PRESETS = {
  safe: {
    minDelaySec: 25,
    maxDelaySec: 90,
    searchEverySec: 180,
    maxRepliesPerHour: 10,
    diversityCooldownSec: 1800,
    // Per-author cooldown — never reply to the same @handle more often
    // than every N hours, regardless of how many of their tweets match.
    authorCooldownHours: 24,
    // Force-reset HomeTimeline scroll cursor every N minutes so a busy
    // feed (which would otherwise never produce two consecutive empty
    // pages) still cycles back to the top to pick up fresh tweets.
    cursorRefreshMin: 30,
    // Balance between commenter-replies (under whale posts) and feed-replies
    // (direct to tweet authors). 0.5 = 50/50, 1.0 = only commenters, 0 = only feed.
    commenterRatio: 0.5,
  },
  medium: {
    minDelaySec: 25,
    maxDelaySec: 80,
    searchEverySec: 150,
    maxRepliesPerHour: 30,
    diversityCooldownSec: 1200,
    authorCooldownHours: 24,
    cursorRefreshMin: 30,
    commenterRatio: 0.5,
  },
  // 1000 replies/day target. With sleep OFF (default now) we have all 24
  // active hours and a hard hourly cap of 50 ⇒ 1200/day ceiling. With
  // HomeTimeline-based scanning we don't hit SearchTimeline rate limits
  // anymore; the bottleneck is the per-reply cooldown and account-level
  // CreateTweet quota. min=25/max=80 gives a log-normal mean ~50s ⇒
  // sustained ~50/h ⇒ ~1200/day under cap.
  // searchEverySec is misnamed at this point — it's now scrollEverySec —
  // but kept for backward-compat with existing config_json. Its actual
  // role: throttle on consecutive empty feed scans.
  highvolume: {
    minDelaySec: 25,
    maxDelaySec: 80,
    searchEverySec: 60,
    maxRepliesPerHour: 50,
    diversityCooldownSec: 600,
    authorCooldownHours: 24,
    // Tighter on highvolume: feed is consumed faster, refresh-to-top
    // more often so we don't reply to stale tweets older than 15min.
    cursorRefreshMin: 15,
    commenterRatio: 0.5,
  },
};

export function presetPacing(name) {
  const p = PRESETS[name];
  if (!p) throw new Error(`unknown preset "${name}". Try: ${Object.keys(PRESETS).join(', ')}`);
  return { ...p };
}

// Used by /new to seed a freshly-created campaign. We default to safe
// because 'highvolume on a fresh cold account' is the common foot-gun.
export function defaultCampaignConfig(presetName = 'safe') {
  return {
    keywords: [],
    templates: [],
    persona: null,
    lang: 'en',
    filters: baseFilters(),
    pacing: presetPacing(presetName),
    sleep: baseSleep(),
    replyToCommenters: true, // reply to commenters under whale posts (safer than replying to authors)
    autoDraft: true,         // auto-generate and schedule 3-6 posts/day from feed topics
    autoReplyOwn: true,      // auto-reply to comments on own posts within 5 min (x150 algo boost)
  };
}

export function expectedDailyReplies(cfg) {
  const cap = cfg?.pacing?.maxRepliesPerHour || 0;
  const sleep = cfg?.sleep;
  let activeHours = 24;
  if (sleep?.enabled) {
    const start = parseHHMM(sleep.startHHMM);
    const end = parseHHMM(sleep.endHHMM);
    if (start != null && end != null) {
      const sleepMin = start <= end ? (end - start) : ((24 * 60) - start + end);
      activeHours = 24 - sleepMin / 60;
    }
  }
  return Math.round(cap * activeHours);
}

// Telegram /new walkthrough: keywords prompt should reflect the new
// HomeTimeline-based scanning. Keywords are no longer X search syntax
// (those would 404 on a different endpoint anyway); they're substrings
// matched against tweet.text. Multi-word keywords match if all tokens
// appear in any order.
function stepKeywordsHelp() {
  return (
    'Keywords (one per line, case-insensitive substring match against ' +
    'tweet text):\n' +
    '  • Single word: "solana" matches any tweet containing "solana".\n' +
    '  • Multi-word: "gm crypto" matches tweets that contain both "gm" ' +
    'and "crypto" anywhere in the text.\n' +
    '  • Empty list = match everything in your home feed.\n\n' +
    'The bot scans your X home feed (the same feed you scroll) and ' +
    'replies to tweets matching these. If your follow graph is already ' +
    'tuned to a niche, an empty list works fine.'
  );
}

export { stepKeywordsHelp };

