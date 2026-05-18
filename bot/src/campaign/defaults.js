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
  },
  medium: {
    minDelaySec: 25,
    maxDelaySec: 80,
    searchEverySec: 150,
    maxRepliesPerHour: 30,
    diversityCooldownSec: 1200,
  },
  // 1000 replies/day target. With sleep 01-08 we have 17 active hours;
  // 1000 / 17 ≈ 59 sustained. Cap 70 leaves headroom for jitter & dry tick.
  // Mean delay from log-normal with min=20, max=100 lands ~55-65s, which
  // pairs cleanly with 60/h. searchEverySec=120 because we burn queue fast.
  highvolume: {
    minDelaySec: 20,
    maxDelaySec: 100,
    searchEverySec: 120,
    maxRepliesPerHour: 70,
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

function parseHHMM(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}
