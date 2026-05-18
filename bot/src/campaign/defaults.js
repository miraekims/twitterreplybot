// Conservative defaults for fresh accounts. Per the prior project's docs:
// stay under 10/h for the first week before scaling up.
export function defaultCampaignConfig() {
  return {
    keywords: [],
    templates: [],
    persona: null,
    lang: 'en',
    filters: {
      minLikes: 1,
      minTweetAgeSec: 60,         // 1 minute (don't reply to fresh posts)
      maxAgeMinutes: 10,          // posts older than 10min are stale
      minAuthorFollowers: 50,
      langs: ['en'],
      skipReplies: true,
      skipRetweets: true,
      skipQuotes: false,
      skipWithUrls: false,
      blacklistWords: [],
      blacklistHandles: [],
    },
    pacing: {
      minDelaySec: 25,
      maxDelaySec: 90,
      searchEverySec: 180,
      maxRepliesPerHour: 10,      // start small; ramp up after a week
      diversityCooldownSec: 1800,
    },
    sleep: {
      enabled: true,
      startHHMM: '01:00',
      endHHMM: '08:00',
    },
  };
}
