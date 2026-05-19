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
  minLikes: 0,
  minTweetAgeSec: 30,       // give X a moment to drop fake-engagement spam
  maxAgeMinutes: 240,       // 4 hours — feed delivers fresh stuff anyway
  minAuthorFollowers: 0,
  langs: ['en'],
  skipReplies: true,
  skipRetweets: true,
  skipQuotes: false,
  skipWithUrls: false,
  blacklistWords: [],
  blacklistHandles: [],
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
  },
  medium: {
    minDelaySec: 25,
    maxDelaySec: 80,
    searchEverySec: 150,
    maxRepliesPerHour: 30,
    diversityCooldownSec: 1200,
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

