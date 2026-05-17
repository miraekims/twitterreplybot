// Auto-reply runner. MV3-safe: tick-based via chrome.alarms.
//
// In Manifest V3 the service worker is killed after ~30s of inactivity.
// A long-running setTimeout/setInterval loop would die silently. Instead,
// each step is one alarm tick:
//
//   tick:
//     1. read state from storage (state survives SW restarts)
//     2. decide next action (search | reply | sleep)
//     3. perform exactly one action
//     4. schedule the next alarm and return
//
// State machine (persisted in storage):
//   status:         'idle' | 'running' | 'stopped'
//   queue:          [{ id, authorHandle, authorName, _matchedKeyword, ... }]
//   sentInSession:  number
//   lastSearchAt:   epoch ms
//   nextActionAt:   epoch ms (when the next tick should do something)
//   lastError:      string | null
import { searchTimeline, createTweet } from '../background/x-api.js';
import { storage } from './storage.js';

const STATE_KEY  = 'auto.state';
const SENT_KEY   = 'auto.sent';     // { [tweetId]: ts }
const LOGS_KEY   = 'auto.logs';     // [{ ts, level, msg }]
const CONFIG_KEY = 'auto.config';
const ALARM_NAME = 'xbot.autoTick';

const MAX_LOGS = 200;
const MAX_SENT = 5000;

const defaultConfig = {
  keywords: [],
  templates: [],
  filters: {
    minLikes: 0,
    maxAgeMinutes: 240,
    skipReplies: true,
    skipRetweets: true,
    skipWithUrls: false,
    minAuthorFollowers: 0,
    langs: [],
  },
  pacing: {
    minDelaySec: 25,
    maxDelaySec: 60,
    searchEverySec: 180,
  },
  sessionCap: 30,
};

const defaultState = {
  status: 'idle',
  startedAt: null,
  sentInSession: 0,
  lastError: null,
  lastSearchAt: 0,
  nextActionAt: 0,
  queue: [],
};

// ---------- config / state ----------
export async function getConfig() {
  return { ...defaultConfig, ...(await storage.get(CONFIG_KEY, {})) };
}
export async function setConfig(patch) {
  const cur = await getConfig();
  const next = {
    ...cur,
    ...patch,
    filters: { ...cur.filters, ...(patch.filters || {}) },
    pacing:  { ...cur.pacing,  ...(patch.pacing  || {}) },
  };
  await storage.set(CONFIG_KEY, next);
  return next;
}
export async function getState() {
  return { ...defaultState, ...(await storage.get(STATE_KEY, {})) };
}
async function setState(patch) {
  const cur = await getState();
  const next = { ...cur, ...patch };
  await storage.set(STATE_KEY, next);
  return next;
}

// ---------- logs ----------
async function log(level, msg) {
  const entry = { ts: Date.now(), level, msg };
  await storage.update(LOGS_KEY, (cur) => {
    const arr = Array.isArray(cur) ? cur.slice(-MAX_LOGS + 1) : [];
    arr.push(entry);
    return arr;
  }, []);
}
export async function getLogs() { return (await storage.get(LOGS_KEY, [])) || []; }
export async function clearLogs() { await storage.set(LOGS_KEY, []); }

// ---------- dedup ----------
async function isAlreadySent(id) {
  const sent = (await storage.get(SENT_KEY, {})) || {};
  return !!sent[id];
}
async function markSent(id) {
  await storage.update(SENT_KEY, (cur) => {
    const obj = cur || {};
    obj[id] = Date.now();
    const keys = Object.keys(obj);
    if (keys.length > MAX_SENT) {
      keys.sort((a, b) => obj[a] - obj[b]);
      for (let i = 0; i < keys.length - MAX_SENT; i++) delete obj[keys[i]];
    }
    return obj;
  }, {});
}

// ---------- helpers ----------
function jitterSec(min, max) {
  const lo = Math.max(1, min | 0);
  const hi = Math.max(lo, max | 0);
  return lo + Math.random() * (hi - lo);
}
function passesFilters(t, f) {
  if (!t || !t.id || !t.text) return false;
  if (f.skipReplies && t.isReply) return false;
  if (f.skipRetweets && t.isRetweet) return false;
  if (f.skipWithUrls && t.hasUrls) return false;
  if (f.minLikes && (t.favoriteCount || 0) < f.minLikes) return false;
  if (f.minAuthorFollowers && (t.authorFollowers || 0) < f.minAuthorFollowers) return false;
  if (f.langs && f.langs.length && t.lang && !f.langs.includes(t.lang)) return false;
  if (f.maxAgeMinutes && t.createdAt) {
    const age = (Date.now() - new Date(t.createdAt).getTime()) / 60000;
    if (age > f.maxAgeMinutes) return false;
  }
  return true;
}
function renderTemplate(tpl, ctx) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (ctx[k] != null ? String(ctx[k]) : ''));
}
function pickTemplate(templates) {
  if (!templates || !templates.length) return null;
  return templates[Math.floor(Math.random() * templates.length)];
}

// ---------- alarms ----------
async function scheduleNext(delaySec) {
  const when = Date.now() + Math.max(1, delaySec) * 1000;
  await setState({ nextActionAt: when });
  // chrome.alarms minimum is technically 30s in production builds, but in
  // unpacked dev mode any positive delayInMinutes works. We use `when:` so
  // we can pass an absolute timestamp without rounding.
  chrome.alarms.create(ALARM_NAME, { when });
}
async function clearAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
}

// ---------- core tick ----------
// One tick = one decision + one action. Never blocks for long.
export async function tick() {
  const state = await getState();
  if (state.status !== 'running') {
    await clearAlarm();
    return;
  }
  const cfg = await getConfig();

  // Validation guards.
  if (!cfg.keywords.length || !cfg.templates.length) {
    await log('error', 'no keywords or templates — stopping');
    await stop();
    return;
  }
  if (state.sentInSession >= cfg.sessionCap) {
    await log('info', `session cap reached (${cfg.sessionCap}) — stopping`);
    await stop();
    return;
  }

  // 1) Queue empty? Run search and refill.
  if (!state.queue.length) {
    const sinceSearch = Date.now() - (state.lastSearchAt || 0);
    if (sinceSearch < cfg.pacing.searchEverySec * 1000) {
      const wait = Math.ceil((cfg.pacing.searchEverySec * 1000 - sinceSearch) / 1000);
      await scheduleNext(wait);
      return;
    }
    let candidates = [];
    try {
      candidates = await runSearch(cfg);
    } catch (e) {
      await log('error', `search blocked: ${e.message}`);
      if (e.status === 401 || e.status === 403 || e.status === 429) {
        await setState({ lastError: e.message });
        await stop();
        return;
      }
      // soft failure — try again later
      await scheduleNext(jitterSec(15, 30));
      return;
    }
    // Filter + dedup.
    const usable = [];
    for (const t of candidates) {
      if (!passesFilters(t, cfg.filters)) continue;
      if (await isAlreadySent(t.id)) continue;
      usable.push(t);
    }
    await setState({ queue: usable, lastSearchAt: Date.now() });
    await log('info', `search → ${candidates.length} found, ${usable.length} usable`);
    // Even if usable=0, schedule next tick so the loop keeps going.
    const delay = usable.length
      ? jitterSec(cfg.pacing.minDelaySec, cfg.pacing.maxDelaySec)
      : cfg.pacing.searchEverySec;
    await scheduleNext(delay);
    return;
  }

  // 2) Pop one tweet from the queue and reply.
  const queue = state.queue.slice();
  const t = queue.shift();
  await setState({ queue });

  // Race-condition guard: someone may have replied between search and now.
  if (await isAlreadySent(t.id)) {
    await scheduleNext(2);
    return;
  }

  const tpl = pickTemplate(cfg.templates);
  const text = renderTemplate(tpl, {
    author: t.authorHandle || '',
    name:   t.authorName   || '',
  });

  try {
    await createTweet({ text, replyToTweetId: t.id });
    await markSent(t.id);
    const s = await getState();
    await setState({ sentInSession: s.sentInSession + 1 });
    await log('info', `replied to @${t.authorHandle} (${t.id}) [kw="${t._matchedKeyword}"]`);
  } catch (e) {
    await log('error', `reply to ${t.id} failed: ${e.message}`);
    // Mark as sent so we don't retry the same broken tweet forever.
    await markSent(t.id);
    if (e.status === 401 || e.status === 403 || e.status === 429) {
      await setState({ lastError: e.message });
      await stop();
      return;
    }
  }

  // Re-check session cap after sending.
  const s2 = await getState();
  if (s2.sentInSession >= cfg.sessionCap) {
    await log('info', `session cap reached (${cfg.sessionCap}) — stopping`);
    await stop();
    return;
  }
  await scheduleNext(jitterSec(cfg.pacing.minDelaySec, cfg.pacing.maxDelaySec));
}

async function runSearch(cfg) {
  const seen = new Set();
  const all = [];
  for (const kw of cfg.keywords) {
    try {
      const { tweets } = await searchTimeline({ query: kw, count: 20, product: 'Latest' });
      for (const t of tweets) {
        if (!seen.has(t.id)) { seen.add(t.id); all.push({ ...t, _matchedKeyword: kw }); }
      }
    } catch (e) {
      // Hard errors must propagate so the caller can hard-stop.
      if (e.status === 401 || e.status === 403 || e.status === 429) throw e;
      await log('warn', `search "${kw}" failed: ${e.message}`);
    }
    // Tiny pause between keyword searches; not the main pacing.
    await new Promise((r) => setTimeout(r, 800 + Math.random() * 800));
  }
  return all;
}

// ---------- public controls ----------
export async function start() {
  const s = await getState();
  if (s.status === 'running') return s;
  await setState({
    status: 'running',
    startedAt: Date.now(),
    sentInSession: 0,
    lastError: null,
    lastSearchAt: 0,
    queue: [],
  });
  await log('info', 'auto-reply started');
  await scheduleNext(2);
  return getState();
}
export async function stop() {
  await setState({ status: 'idle' });
  await clearAlarm();
  await log('info', 'auto-reply stopped');
  return getState();
}
export async function resetSent() {
  await storage.set(SENT_KEY, {});
  await log('info', 'sent-history cleared');
}

// Wire alarms to tick(). The SW may have just woken up; calling tick() is safe
// because all state is in storage.
export function registerAlarmHandler() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    tick().catch(async (e) => {
      await log('error', 'tick crashed: ' + (e && e.message ? e.message : String(e)));
      await setState({ status: 'idle', lastError: String(e && e.message || e) });
    });
  });
}
