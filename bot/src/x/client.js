// Thin RPC client for X.com operations.
//
// The bot no longer talks to x.com directly. Instead the Chrome extension
// (which is already on x.com, has fresh cookies, queryId, x-client-
// transaction-id and the right TLS fingerprint) does the actual HTTP. We
// just send it RPC calls over the bridge WebSocket and translate the
// results.
//
// Why this is the right architecture:
//   - X rotates queryId on every release. Extension picks it up live.
//   - x-client-transaction-id is a hash over a moving target (their
//     ondemand bundle keeps changing shape). Extension reads it directly
//     out of the page's own outgoing requests.
//   - ct0 cookie rotates per-session. Extension uses chrome.cookies API,
//     always current. Bot would have to chase Set-Cookie headers, which
//     curl-impersonate didn't expose well.
//   - TLS / JA3 / HTTP2 fingerprint: matters for x.com WAF. Real Chrome
//     trivially passes; replicating it server-side is a maintenance
//     burden we just deleted.
//
// Public surface kept identical to the old XClient so runner.js doesn't
// care it's now a different transport — same `searchTimeline` /
// `createTweet` shape, same error.status semantics.
import { bridge } from '../bridge/server.js';

export class XClient {
  // Ctor signature stays for callers that already pass it. We don't need
  // any of the args though — the extension owns secrets/proxy/lang now.
  // eslint-disable-next-line no-unused-vars
  constructor({ secrets, proxy = null, lang = 'en' } = {}) {
    this.lang = lang;
  }

  async searchTimeline({ query }) {
    return rpc('x.searchTimeline', { query });
  }

  async homeTimeline({ cursor = null, count = 40 } = {}) {
    return rpc('x.homeTimeline', { cursor, count });
  }

  async tweetDetail({ tweetId }) {
    return rpc('x.tweetDetail', { tweetId });
  }

  async createTweet({ text, replyToTweetId }) {
    return rpc('x.createTweet', { text, replyToTweetId });
  }

  // Lightweight liveness probe — used by /stats. Doesn't actually hit x.com
  // unless the bridge round-trips it.
  async ping() {
    return rpc('ping', {});
  }
}

async function rpc(method, params) {
  try {
    return await bridge.call(method, params);
  } catch (e) {
    // Surface common cases with helpful hints. Status codes propagate from
    // the extension verbatim so runner's 401/403/429 handling still works.
    if (e.code === 'BRIDGE_DISCONNECTED') {
      const err = new Error(
        'Chrome extension is not connected. Open Chrome on x.com (logged in) and ' +
        'reload the extension at chrome://extensions if needed.',
      );
      err.code = 'BRIDGE_DISCONNECTED';
      throw err;
    }
    throw e;
  }
}
