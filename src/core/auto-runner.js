// Auto-reply runner.
//
// Lives in the service worker. Given a campaign config:
//   { keywords:[], templates:[], filters:{...}, pacing:{...}, sessionCap }
// it loops:
//   1. search X for tweets matching ANY keyword
//   2. drop tweets that don't pass filters or were already replied to
//   3. pick a random unused template, send reply
//   4. wait jittered delay, repeat
//
// State:
//   - status: 'idle' | 'running' | 'paused' | 'stopped'
//   - sentIds: Set of tweet ids we've already replied to (persisted)
//   - logs: ring buffer of recent actions/errors
//
// Hard stop on auth failures (401/403/429): we never keep firing into a wall.
import { searchTimeline, createTweet } from '../background/x-api.js';
import { storage } from './storage.js';

const STATE_KEY = 'auto.state';
const SENT_KEY = 'auto.sent';      // { [tweetId]: ts }
const LOGS_KEY = 'auto.logs';      // [{ ts, level, msg }]
const CONFIG_KEY = 'auto.config';

const MAX_LOGS = 200;
const MAX_SENT = 5000;

let runningTimer = null;
let abortFlag = false;

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
    langs: [], // e.g. ['en']
  },
  pacing: {
    minDelaySec: 25,
    maxDelaySec: 60,
    searchEverySec: 180, // re-run search every N seconds
  },
  sessionCap: 30, // max replies before auto-stop
};

const defaultState = {
  status: 'idle',
  startedAt: null,
  sentInSession: 0,
  lastError: null,
  lastSearchAt: null,
  queue: [], // tweet ids pending reply
};

export async function getConfig() {
  return { ...defaultConfig, ...(await storage.get(CONFIG_KEY, {})) };
}
export async function setConfig(patch) {
  const cur = await getConfig();
  const next = {
    ...cur,
    ...patch,
    filters: { ...cur.filters, ...(patch.filters || {}) },
    pacing: { ...cur.pacing, ...(patch.pacing || {}) },
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

async function log(level, msg) {
  const entry = { ts: Date.now(), level, msg };
  await storage.update(LOGS_KEY, (cur) => {
    const arr = Array.isArray(cur) ? cur.slice(-MAX_LOGS + 1) : [];
    arr.push(entry);
    return arr;
  }, []);
}
export async function getLogs() {
  return (await storage.get(LOGS_KEY, [])) || [];
}
export async function clearLogs() { await storage.set(LOGS_KEY, []); }

async function isAlreadySent(id) {
  const sent = (await storage.get(SENT_KEY, {})) || {};
  return !!sent[id];
}
async function markSent(id) {
  await storage.update(SENT_KEY, (cur) => {
    const obj = cur || {};
    obj[id] = Date.now();
    // Trim if too big.
    const keys = Object.keys(obj);
    if (keys.length > MAX_SENT) {
      keys.sort((a, b) => obj[a] - obj[b]);
      for (let i = 0; i < keys.length - MAX_SENT; i++) delete obj[keys[i]];
    }
    return obj;
  }, {});
}

function jitterMs(minSec, maxSec) {
  const lo = Math.max(1, minSec | 0);
  const hi = Math.max(lo, maxSec | 0);
  return (lo + Math.random() * (hi - lo)) * 1000;
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

// --- search & reply loop ---
async function searchPhase(cfg) {
  const seenIds = new Set();
  const all = [];
  for (const kw of cfg.keywords) {
    if (abortFlag) return all;
    try {
      const { tweets } = await searchTimeline({ query: kw, count: 20, product: 'Latest' });
      for (const t of tweets) {
        if (!seenIds.has(t.id)) { seenIds.add(t.id); all.push({ ...t, _matchedKeyword: kw }); }
      }
      await log('info', `search "${kw}" -> ${tweets.length} tweets`);
    } catch (e) {
      await log('error', `search "${kw}" failed: ${e.message}`);
      if (e.status === 401 || e.status === 403 || e.status === 429) throw e;
    }
    await sleep(jitterMs(2, 5));
  }
  await setState({ lastSearchAt: Date.now() });
  return all;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function loop() {
  abortFlag = false;
  await setState({ status: 'running', startedAt: Date.now(), sentInSession: 0, lastError: null });
  await log('info', 'auto-reply started');

  while (!abortFlag) {
    const cfg = await getConfig();
    const state = await getState();

    if (!cfg.keywords.length || !cfg.templates.length) {
      await log('error', 'no keywords or templates configured — stopping');
      break;
    }
    if (state.sentInSession >= cfg.sessionCap) {
      await log('info', `session cap reached (${cfg.sessionCap}) — stopping`);
      break;
    }

    let candidates;
    try {
      candidates = await searchPhase(cfg);
    } catch (e) {
      await log('error', `search blocked: ${e.message} — hard stop`);
      await setState({ lastError: e.message });
      break;
    }

    let actedThisCycle = 0;
    for (const t of candidates) {
      if (abortFlag) break;
      if (!passesFilters(t, cfg.filters)) continue;
      if (await isAlreadySent(t.id)) continue;

      const tpl = pickTemplate(cfg.templates);
      const text = renderTemplate(tpl, {
        author: t.authorHandle || '',
        name: t.authorName || '',
      });

      try {
        await createTweet({ text, replyToTweetId: t.id });
        await markSent(t.id);
        const s = await getState();
        await setState({ sentInSession: s.sentInSession + 1 });
        actedThisCycle++;
        await log('info', `replied to @${t.authorHandle} (${t.id}) [kw="${t._matchedKeyword}"]`);
      } catch (e) {
        await log('error', `reply to ${t.id} failed: ${e.message}`);
        if (e.status === 401 || e.status === 403 || e.status === 429) {
          await setState({ lastError: e.message });
          await log('error', 'auth/rate-limit error — hard stop');
          abortFlag = true;
          break;
        }
        // mark sent anyway so we don't keep trying the same tweet forever
        await markSent(t.id);
      }

      const s2 = await getState();
      if (s2.sentInSession >= cfg.sessionCap) { abortFlag = true; break; }

      await sleep(jitterMs(cfg.pacing.minDelaySec, cfg.pacing.maxDelaySec));
    }

    if (abortFlag) break;
    if (actedThisCycle === 0) {
      await log('info', 'no new matches this cycle, sleeping before next search');
    }
    await sleep(Math.max(15000, (cfg.pacing.searchEverySec | 0) * 1000));
  }

  await setState({ status: 'idle' });
  await log('info', 'auto-reply stopped');
}

export async function start() {
  const s = await getState();
  if (s.status === 'running') return s;
  loop().catch(async (e) => {
    await log('error', 'fatal: ' + e.message);
    await setState({ status: 'idle', lastError: e.message });
  });
  return getState();
}
export async function stop() {
  abortFlag = true;
  await setState({ status: 'idle' });
  await log('info', 'stop requested');
  return getState();
}
export async function resetSent() {
  await storage.set(SENT_KEY, {});
  await log('info', 'sent-history cleared');
}
