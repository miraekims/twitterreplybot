// Watchdog. Two responsibilities:
//
// 1. Bridge reconnect insurance. The MV3 service worker is supposed to be
//    kept alive by an open WebSocket, but in practice Chrome can still
//    suspend the SW during long-idle periods (especially after lid-close
//    or hibernate). When the SW wakes back up, we want the WS to come back
//    immediately, not wait for some user action. A `chrome.alarms` ping
//    that fires every minute guarantees the SW gets called and gives the
//    bridge client a chance to reconnect if it's down.
//
// 2. Periodic x.com touch. The bot's whole value proposition is that the
//    extension watches live page traffic and learns the latest queryId,
//    headers and tid. That requires the user's x.com tab to actually do
//    things. When the user is away for 6+ hours, captured shapes go stale
//    and the next bot reply could 404. So once every TOUCH_INTERVAL we
//    open a hidden x.com tab, let it issue its initial GraphQL warm-up
//    requests (HomeTimeline, etc), then close it. The user doesn't see
//    the tab — Chrome creates it offscreen with `active: false`.
//
//    Caveat: this counts toward X's "active tab" heuristics for the
//    account, which is fine — it makes the account *look* more active,
//    which is what we want anyway.

import { ensureConnected } from './bridge-client.js';

const ALARM_BRIDGE = 'xbot.bridgeWatchdog';
const ALARM_TOUCH = 'xbot.xTouch';

const BRIDGE_WATCHDOG_PERIOD_MIN = 1;     // every minute
const X_TOUCH_PERIOD_MIN = 6 * 60;         // every 6 hours
const TOUCH_TAB_TTL_MS = 8_000;            // close the touch tab after 8s

export function registerKeepalive() {
  // Idempotent — alarms persist across SW restarts so we don't double-create.
  chrome.alarms.create(ALARM_BRIDGE, {
    periodInMinutes: BRIDGE_WATCHDOG_PERIOD_MIN,
    delayInMinutes: BRIDGE_WATCHDOG_PERIOD_MIN,
  });
  chrome.alarms.create(ALARM_TOUCH, {
    periodInMinutes: X_TOUCH_PERIOD_MIN,
    delayInMinutes: X_TOUCH_PERIOD_MIN,
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_BRIDGE) {
      ensureConnected();
      return;
    }
    if (alarm.name === ALARM_TOUCH) {
      touchXcom().catch((e) => console.warn('[xbot keepalive] touch failed:', e.message));
      return;
    }
  });
}

async function touchXcom() {
  // Skip if user already has an x.com tab open — the page is naturally
  // refreshing observations as they browse. No need to add a hidden tab.
  const existing = await chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] });
  if (existing.length > 0) return;

  console.log('[xbot keepalive] no x.com tab open — touching one in background');
  const tab = await chrome.tabs.create({ url: 'https://x.com/home', active: false });
  // Give the page enough time to fire its initial GraphQL warm-up. 8s is a
  // pragmatic compromise: enough for HomeTimeline + UserByScreenName, short
  // enough that Chrome can suspend the touched tab quickly afterwards.
  setTimeout(() => {
    chrome.tabs.remove(tab.id).catch(() => {});
  }, TOUCH_TAB_TTL_MS);
}
