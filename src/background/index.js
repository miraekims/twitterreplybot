// Service worker — message router.
import { recordObservation, getAllOps, getHeaders } from './query-registry.js';
import { tweetDetail, createTweet, searchTimeline } from './x-api.js';
import {
  getConfig, setConfig, getState, getLogs, clearLogs,
  start as autoStart, stop as autoStop, resetSent,
  registerAlarmHandler,
} from '../core/auto-runner.js';

// Register at top level so the SW re-registers on every wake-up.
registerAlarmHandler();

const handlers = {
  'capture.observe': async ({ kind, data }) => {
    if (kind === 'graphql-seen') await recordObservation(data);
    return { acknowledged: true };
  },
  'capture.state': async () => {
    const [ops, headers] = await Promise.all([getAllOps(), getHeaders()]);
    const summary = {};
    for (const name of Object.keys(ops)) {
      summary[name] = { queryId: ops[name].queryId, lastSeen: ops[name].lastSeen };
    }
    return {
      ops: summary,
      hasAuth: !!headers.authorization,
      ready: !!ops.SearchTimeline && !!ops.CreateTweet && !!headers.authorization,
    };
  },
  // legacy (Comments tab — kept for later)
  'x.tweetDetail': (p) => tweetDetail(p),
  'x.createTweet': (p) => createTweet(p),
  'x.searchTimeline': (p) => searchTimeline(p),
  // Diagnostic: run one search and return as much info as possible.
  'debug.testSearch': async ({ query }) => {
    const ops = await getAllOps();
    const op = ops.SearchTimeline;
    let result = { capturedOp: op || null };
    try {
      const r = await searchTimeline({ query: query || 'crypto', count: 10, product: 'Latest' });
      result.ok = true;
      result.tweetCount = (r.tweets || []).length;
      result.sample = (r.tweets || []).slice(0, 2);
    } catch (e) {
      result.ok = false;
      result.error = e.message;
      result.errorStatus = e.status || null;
      result.errorUrl = e.url || null;
      result.errorBody = (e.body || '').slice(0, 500);
    }
    return result;
  },
  // auto-reply campaign
  'auto.getConfig': () => getConfig(),
  'auto.setConfig': (p) => setConfig(p || {}),
  'auto.getState': () => getState(),
  'auto.getLogs': () => getLogs(),
  'auto.clearLogs': () => clearLogs(),
  'auto.start': () => autoStart(),
  'auto.stop': () => autoStop(),
  'auto.resetSent': () => resetSent(),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = handlers[msg && msg.type];
  if (!fn) {
    sendResponse({ ok: false, error: 'Unknown message: ' + (msg && msg.type) });
    return false;
  }
  Promise.resolve()
    .then(() => fn(msg.payload || {}))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
  return true;
});
