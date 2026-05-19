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
  minLikes: 1,
  minTweetAgeSec: 60,
  maxAgeMinutes: 10,
  minAuthorFollowers: 50,
  langs: ['en'],
  skipReplies: true,
  skipRetweets: true,
  skipQuotes: false,
  skipWithUrls: false,
  blacklistWords: [],
  blacklistHandles: [],
});

const baseSleep = () => ({
  enabled: true,
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
    authorCooldownHours: 24,
    cursorRefreshMin: 30,
  },
  medium: {
    minDelaySec: 25,
    maxDelaySec: 80,
    searchEverySec: 150,
    maxRepliesPerHour: 30,
    diversityCooldownSec: 1200,
    authorCooldownHours: 24,
    cursorRefreshMin: 30,
  },
  // 1000 replies/day target. Math: with sleep 01-08 we have 17 active hours
  // and a hard hourly cap of 75 ⇒ 1275 ceiling, leaving headroom for:
  //   (a) ~2.5s/reply supervisor-tick slop (≈ 40min/day at the target rate)
  //   (b) jitter variance — log-normal mean with min=25,max=80 is ~50s,
  //       which paired with the 75/h cap gives sustained ~64/h ⇒ 1088/day
  //       on average, with the cap absorbing fast-window spikes.
  //   (c) search misses & filtered-out tweets (the runner now refills the
  //       queue immediately when the previous search was non-empty, so the
  //       only real loss is a few seconds of search latency).
  // The min/max delays are ALSO narrower than safe/medium — wider jitter on
  // a high-volume account is a tell, not a feature; humans on Twitter don't
  // pause 100s between replies during an active conversation but do pause
  // 15-25s while typing.
  highvolume: {
    minDelaySec: 25,
    maxDelaySec: 80,
    searchEverySec: 90,
    maxRepliesPerHour: 75,
    diversityCooldownSec: 600,
    authorCooldownHours: 24,
    // Tighter on highvolume: we're churning through search results faster,
    // so refresh-to-top more often to avoid replying to stale 30-min-old
    // tweets when fresh ones are arriving every minute.
    cursorRefreshMin: 15,
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

function parseHHMM(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}
