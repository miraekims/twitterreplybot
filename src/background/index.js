// Service worker — message router.
import { recordObservation, getAllOps, getHeaders } from './query-registry.js';
import { tweetDetail, createTweet } from './x-api.js';
import {
  getConfig, setConfig, getState, getLogs, clearLogs,
  start as autoStart, stop as autoStop, resetSent,
} from '../core/auto-runner.js';

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
