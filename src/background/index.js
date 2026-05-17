// Service worker — message router.
//
// Inbound messages from content/modal:
//   capture.observe { kind, data }    — forwarded GraphQL traffic from page-hook
//   capture.state                     — return summary of what's captured
//   x.tweetDetail   { tweetId }       — load replies under a tweet
//   x.createTweet   { text, replyToTweetId } — post reply
//
// Every handler returns { ok: true, data } or { ok: false, error }.
import { recordObservation, getAllOps, getHeaders } from './query-registry.js';
import { tweetDetail, createTweet } from './x-api.js';

const handlers = {
  'capture.observe': async ({ kind, data }) => {
    if (kind === 'graphql-seen') {
      await recordObservation(data);
    }
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
      ready: !!ops.TweetDetail && !!ops.CreateTweet && !!headers.authorization,
    };
  },
  'x.tweetDetail': (p) => tweetDetail(p),
  'x.createTweet': (p) => createTweet(p),
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
  return true; // async response
});
