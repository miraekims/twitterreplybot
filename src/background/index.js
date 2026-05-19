// Service worker — message router + bot bridge client + watchdog.
//
// Two ingress channels:
//   1. chrome.runtime.onMessage — the modal UI and content scripts
//      (capture.observe, auto.start, debug.testSearch, ...)
//   2. WebSocket from the bot — the new bridge. The bot drives all
//      production traffic through here. Routed through the same
//      handlers map as channel 1.
import { recordObservation, getAllOps, getHeaders } from './query-registry.js';
import { tweetDetail, createTweet, searchTimeline, homeTimeline } from './x-api.js';
import {
  getConfig, setConfig, getState, getLogs, clearLogs,
  start as autoStart, stop as autoStop, resetSent,
  registerAlarmHandler,
} from '../core/auto-runner.js';
import {
  startBridge, getBridgeStatus, getBridgeSettings, setBridgeSettings,
} from './bridge-client.js';
import { registerKeepalive } from './keepalive.js';

const EXT_VERSION = chrome.runtime.getManifest().version;
console.log(`[xbot] service worker booted, version ${EXT_VERSION}`);

registerAlarmHandler();
registerKeepalive();

// Start the bridge client. dispatchRpc is what the server calls into when
// it sends an rpc.req frame — same shape as in-extension messages, so we
// can reuse the same handlers map.
startBridge(dispatchRpc);

const handlers = {
  // ----- capture (from page-hook via content script) -----
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
      hasTxId: !!headers['x-client-transaction-id'],
      ready: !!ops.SearchTimeline && !!ops.CreateTweet && !!headers.authorization,
      extVersion: EXT_VERSION,
    };
  },

  // ----- bridge config (modal options) -----
  'bridge.getStatus': () => getBridgeStatus(),
  'bridge.getSettings': () => getBridgeSettings(),
  'bridge.setSettings': (p) => setBridgeSettings(p || {}),

  // ----- raw X.com ops (used by both the modal "Comments" tab AND the
  //       bridge RPCs from the bot) -----
  'x.tweetDetail': (p) => tweetDetail(p),
  'x.createTweet': (p) => createTweet(p),
  'x.searchTimeline': (p) => searchTimeline(p),
  'x.homeTimeline': (p) => homeTimeline(p),

  // ----- bot bridge maintenance -----
  // The bot may issue 'ping' as a no-arg liveness check.
  ping: async () => ({ ok: true, ts: Date.now(), extVersion: EXT_VERSION }),

  // ----- diagnostics (modal Status tab) -----
  'debug.testSearch': async ({ query }) => {
    const ops = await getAllOps();
    const op = ops.SearchTimeline;
    let result = { capturedOp: op || null };
    try {
      const r = await searchTimeline({ query: query || 'crypto' });
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

  // ----- legacy in-extension auto-runner (kept for the modal users) -----
  'auto.getConfig': () => getConfig(),
  'auto.setConfig': (p) => setConfig(p || {}),
  'auto.getState': () => getState(),
  'auto.getLogs': () => getLogs(),
  'auto.clearLogs': () => clearLogs(),
  'auto.start': () => autoStart(),
  'auto.stop': () => autoStop(),
  'auto.resetSent': () => resetSent(),
};

// Used by both the chrome.runtime.onMessage path and the WS bridge.
async function dispatchRpc(method, params) {
  const fn = handlers[method];
  if (!fn) throw new Error(`unknown method: ${method}`);
  return fn(params || {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') {
    sendResponse({ ok: false, error: 'bad message' });
    return false;
  }
  Promise.resolve()
    .then(() => dispatchRpc(msg.type, msg.payload))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
  return true;
});
