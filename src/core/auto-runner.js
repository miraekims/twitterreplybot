// Auto-reply runner. MV3-safe: tick-based via chrome.alarms.
//
// In Manifest V3 the service worker is killed after ~30s of inactivity.
// A long-running setTimeout/setInterval loop would die silently. Instead,
// each step is one alarm tick, with all state persisted to chrome.storage.local
// so it survives SW restarts.
//
// Anti-pattern protections (lifted from previously-built best practices):
//   - token-bucket rate limit: maxRepliesPerHour
//   - sleep window: optional quiet hours (HH:MM..HH:MM, local time)
//   - log-normal delays: humans don't have Gaussian pause distributions
//   - min tweet age: never reply within seconds of a post
//   - diversity cooldown: don't repeat the same template too soon
//   - blacklists: words & user handles that bypass the reply pipeline
//   - hard stop on auth failures (401/403/429): never spam into a wall
import { searchTimeline, createTweet } from '../background/x-api.js';
import { storage } from './storage.js';

const STATE_KEY  = 'auto.state';
const SENT_KEY   = 'auto.sent';     // { [tweetId]: ts }
const LOGS_KEY   = 'auto.logs';
const CONFIG_KEY = 'auto.config';
const RECENT_TPL_KEY = 'auto.recentTpl'; // [{ tpl, ts }]
const HOUR_LOG_KEY = 'auto.hourLog';     // [ts1, ts2, ...] — replies in last 1h

const ALARM_NAME = 'xbot.autoTick';
const MAX_LOGS = 200;
const MAX_SENT = 5000;

const defaultConfig = {
  keywords: [],
  templates: [],
  filters: {
    minLikes: 0,
    minTweetAgeSec: 60,        // do not reply within 60s of post (looks botty)
    maxAgeMinutes: 30,
    skipReplies: true,
    skipRetweets: true,
    skipQuotes: false,
    skipWithUrls: false,
    minAuthorFollowers: 50,
    langs: [],
    blacklistWords: [],        // case-insensitive substring match on tweet text
    blacklistHandles: [],      // case-insensitive screen_name match
  },
  pacing: {
    minDelaySec: 25,
    maxDelaySec: 90,
    searchEverySec: 180,
    maxRepliesPerHour: 15,     // hard cap: token bucket over rolling 60min
    diversityCooldownSec: 1800,// don't repeat same template within 30min
  },
  sleep: {
    enabled: false,
    startHHMM: '01:00',
    endHHMM:   '08:00',
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
  return mergeDeep(defaultConfig, (await storage.get(CONFIG_KEY, {})) || {});
}
function mergeDeep(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = mergeDeep(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
export async function setConfig(patch) {
  const cur = await getConfig();
  const next = mergeDeep(cur, patch || {});
  await storage.set(CONFIG_KEY, next);
  return next;
}
export async function getState() {
  return { ...defaultState, ...((await storage.get(STATE_KEY, {})) || {}) };
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

// ---------- delay distribution ----------
// log-normal: many short pauses, a few long ones. Looks human.
function logNormalSec(minSec, maxSec) {
  const lo = Math.max(1, minSec);
  const hi = Math.max(lo + 1, maxSec);
  // Box-Muller → standard normal
  let u1 = Math.random(); if (u1 < 1e-9) u1 = 1e-9;
  const u2 = Math.random();
  const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  // Map to log-normal centred between lo..hi
  const mid = (lo + hi) / 2;
  const sigma = 0.45;
  const mu = Math.log(mid);
  let v = Math.exp(mu + sigma * n);
  if (v < lo) v = lo + Math.random() * (hi - lo) * 0.2;
  if (v > hi * 1.5) v = hi - Math.random() * (hi - lo) * 0.2;
  return v;
}

// ---------- sleep window ----------
function inSleepWindow(cfgSleep, nowMs = Date.now()) {
  if (!cfgSleep || !cfgSleep.enabled) return null;
  const d = new Date(nowMs);
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = parseHHMM(cfgSleep.startHHMM);
  const end = parseHHMM(cfgSleep.endHHMM);
  if (start == null || end == null) return null;
  let inside;
  if (start <= end) inside = cur >= start && cur < end;
  else inside = cur >= start || cur < end; // window crosses midnight
  if (!inside) return null;
  // Compute seconds until window end.
  let mins;
  if (start <= end) mins = end - cur;
  else mins = cur >= start ? (24 * 60 - cur) + end : end - cur;
  return mins * 60;
}
function parseHHMM(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// ---------- token bucket ----------
async function recordHourlyAction() {
  await storage.update(HOUR_LOG_KEY, (cur) => {
    const arr = Array.isArray(cur) ? cur.slice() : [];
    arr.push(Date.now());
    return arr;
  }, []);
}
async function pruneHourlyAndCount() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const cur = (await storage.get(HOUR_LOG_KEY, [])) || [];
  const kept = cur.filter((t) => t >= cutoff);
  if (kept.length !== cur.length) await storage.set(HOUR_LOG_KEY, kept);
  return kept;
}

// ---------- diversity ----------
async function recordTemplateUse(tpl) {
  await storage.update(RECENT_TPL_KEY, (cur) => {
    const arr = Array.isArray(cur) ? cur.slice() : [];
    arr.push({ tpl, ts: Date.now() });
    // Keep only last 50 entries.
    return arr.slice(-50);
  }, []);
}
async function pickTemplate(templates, cooldownSec) {
  if (!templates || !templates.length) return null;
  const recent = ((await storage.get(RECENT_TPL_KEY, [])) || [])
    .filter((e) => Date.now() - e.ts < cooldownSec * 1000)
    .map((e) => e.tpl);
  const recentSet = new Set(recent);
  const pool = templates.filter((t) => !recentSet.has(t));
  const src = pool.length ? pool : templates;
  return src[Math.floor(Math.random() * src.length)];
}

// ---------- filters ----------
function passesFilters(t, f) {
  if (!t || !t.id || !t.text) return false;
  if (f.skipReplies && t.isReply) return false;
  if (f.skipRetweets && t.isRetweet) return false;
  if (f.skipQuotes && t.isQuote) return false;
  if (f.skipWithUrls && t.hasUrls) return false;
  if (f.minLikes && (t.favoriteCount || 0) < f.minLikes) return false;
  if (f.minAuthorFollowers && (t.authorFollowers || 0) < f.minAuthorFollowers) return false;
  if (f.langs && f.langs.length && t.lang && !f.langs.includes(t.lang)) return false;

  if (t.createdAt) {
    const ageSec = (Date.now() - new Date(t.createdAt).getTime()) / 1000;
    if (f.minTweetAgeSec && ageSec < f.minTweetAgeSec) return false;
    if (f.maxAgeMinutes && ageSec > f.maxAgeMinutes * 60) return false;
  }

  const handle = (t.authorHandle || '').toLowerCase();
  for (const h of (f.blacklistHandles || [])) {
    if (h && handle === String(h).toLowerCase().replace(/^@/, '')) return false;
  }
  const text = (t.text || '').toLowerCase();
  for (const w of (f.blacklistWords || [])) {
    if (w && text.includes(String(w).toLowerCase())) return false;
  }
  return true;
}

function renderTemplate(tpl, ctx) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (ctx[k] != null ? String(ctx[k]) : ''));
}

// ---------- alarms ----------
async function scheduleNext(delaySec) {
  const when = Date.now() + Math.max(1, delaySec) * 1000;
  await setState({ nextActionAt: when });
  chrome.alarms.create(ALARM_NAME, { when });
}
async function clearAlarm() { await chrome.alarms.clear(ALARM_NAME); }

// ---------- core tick ----------
export async function tick() {
  const state = await getState();
  if (state.status !== 'running') { await clearAlarm(); return; }
  const cfg = await getConfig();

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

  // Sleep window?
  const sleepRemain = inSleepWindow(cfg.sleep);
  if (sleepRemain != null) {
    await log('info', `in sleep window — pausing ${Math.ceil(sleepRemain / 60)} min`);
    await scheduleNext(Math.min(sleepRemain, 30 * 60));
    return;
  }

  // Token bucket: hourly cap?
  const recent = await pruneHourlyAndCount();
  if (recent.length >= cfg.pacing.maxRepliesPerHour) {
    const oldest = recent[0];
    const wait = Math.max(60, Math.ceil((oldest + 60 * 60 * 1000 - Date.now()) / 1000));
    await log('info', `hourly cap (${cfg.pacing.maxRepliesPerHour}) reached — sleeping ${wait}s`);
    await scheduleNext(Math.min(wait, 10 * 60));
    return;
  }

  // 1) Queue empty → search
  if (!state.queue.length) {
    const sinceSearch = Date.now() - (state.lastSearchAt || 0);
    if (state.lastSearchAt && sinceSearch < cfg.pacing.searchEverySec * 1000) {
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
      await scheduleNext(logNormalSec(20, 60));
      return;
    }
    const usable = [];
    for (const t of candidates) {
      if (!passesFilters(t, cfg.filters)) continue;
      if (await isAlreadySent(t.id)) continue;
      usable.push(t);
    }
    await setState({ queue: usable, lastSearchAt: Date.now() });
    await log('info', `search → ${candidates.length} found, ${usable.length} usable`);
    const delay = usable.length
      ? logNormalSec(cfg.pacing.minDelaySec, cfg.pacing.maxDelaySec)
      : cfg.pacing.searchEverySec;
    await scheduleNext(delay);
    return;
  }

  // 2) Pop & reply
  const queue = state.queue.slice();
  const t = queue.shift();
  await setState({ queue });

  if (await isAlreadySent(t.id)) { await scheduleNext(2); return; }

  const tpl = await pickTemplate(cfg.templates, cfg.pacing.diversityCooldownSec);
  const text = renderTemplate(tpl, {
    author: t.authorHandle || '',
    name: t.authorName || '',
  });

  try {
    await createTweet({ text, replyToTweetId: t.id });
    await markSent(t.id);
    await recordHourlyAction();
    await recordTemplateUse(tpl);
    const s = await getState();
    await setState({ sentInSession: s.sentInSession + 1 });
    await log('info', `replied to @${t.authorHandle} (${t.id}) [kw="${t._matchedKeyword}"]`);
  } catch (e) {
    await log('error', `reply to ${t.id} failed: ${e.message}`);
    await markSent(t.id);
    if (e.status === 401 || e.status === 403 || e.status === 429) {
      await setState({ lastError: e.message });
      await stop();
      return;
    }
  }

  const s2 = await getState();
  if (s2.sentInSession >= cfg.sessionCap) {
    await log('info', `session cap reached (${cfg.sessionCap}) — stopping`);
    await stop();
    return;
  }
  await scheduleNext(logNormalSec(cfg.pacing.minDelaySec, cfg.pacing.maxDelaySec));
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
      if (e.status === 401 || e.status === 403 || e.status === 429) throw e;
      const detail = e.url ? ` [${new URL(e.url).pathname}]` : '';
      await log('warn', `search "${kw}" failed: ${e.message}${detail}`);
    }
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

export function registerAlarmHandler() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    tick().catch(async (e) => {
      await log('error', 'tick crashed: ' + (e && e.message ? e.message : String(e)));
      await setState({ status: 'idle', lastError: String((e && e.message) || e) });
    });
  });
}
