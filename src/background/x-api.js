// X.com GraphQL client. Built on top of live observations from the page.
//
// Strategy: for each operation, we replay the *same* request the official client
// issued, only swapping what we actually need to change (e.g. focalTweetId for
// TweetDetail, tweet_text + reply.in_reply_to_tweet_id for CreateTweet).
// This way we don't need a hard-coded list of GraphQL features that drifts with
// every X frontend release.
import { getOp, getHeaders } from './query-registry.js';

const GQL_BASE = 'https://x.com/i/api/graphql';

function safeJsonParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { return null; }
}

async function readCsrfFromCookie() {
  try {
    const ck = await chrome.cookies.get({ url: 'https://x.com', name: 'ct0' });
    return ck && ck.value ? ck.value : null;
  } catch (_) { return null; }
}

async function buildHeaders(extra = {}) {
  const h = await getHeaders();
  const headers = {};
  for (const k of Object.keys(h)) {
    if (k === '_updated') continue;
    headers[k] = h[k];
  }
  // Always refresh CSRF from the live cookie — observations may be stale.
  const csrf = await readCsrfFromCookie();
  if (csrf) headers['x-csrf-token'] = csrf;
  for (const k of Object.keys(extra)) headers[k] = extra[k];
  return headers;
}

async function ensureOp(name) {
  const op = await getOp(name);
  if (!op) throw new Error(
    `Operation ${name} not captured yet. Open X and trigger it once ` +
    `(e.g. open a tweet permalink for TweetDetail, post anything for CreateTweet).`
  );
  return op;
}

// ---- TweetDetail (load replies under a tweet) ----
export async function tweetDetail({ tweetId }) {
  const op = await ensureOp('TweetDetail');
  const baseVars = safeJsonParse(op.variables) || {};
  const variables = { ...baseVars, focalTweetId: String(tweetId) };

  const url = new URL(`${GQL_BASE}/${op.queryId}/TweetDetail`);
  url.searchParams.set('variables', JSON.stringify(variables));
  if (op.features) url.searchParams.set('features', op.features);
  if (op.fieldToggles) url.searchParams.set('fieldToggles', op.fieldToggles);

  const headers = await buildHeaders();
  const resp = await fetch(url.toString(), {
    method: 'GET',
    credentials: 'include',
    headers,
  });
  if (!resp.ok) throw new Error(`TweetDetail HTTP ${resp.status}`);
  const data = await resp.json();
  return { replies: extractReplies(data, tweetId), raw: data };
}

// ---- CreateTweet (post a reply) ----
export async function createTweet({ text, replyToTweetId }) {
  const op = await ensureOp('CreateTweet');
  const baseBody = safeJsonParse(op.body) || {};
  const baseVars = baseBody.variables || {};
  const baseFeatures = baseBody.features || safeJsonParse(op.features) || {};

  const variables = {
    ...baseVars,
    tweet_text: text,
    dark_request: false,
    media: { media_entities: [], possibly_sensitive: false },
    semantic_annotation_ids: [],
  };
  if (replyToTweetId) {
    variables.reply = {
      in_reply_to_tweet_id: String(replyToTweetId),
      exclude_reply_user_ids: [],
    };
  } else {
    delete variables.reply;
  }

  const body = {
    ...baseBody,
    variables,
    features: baseFeatures,
    queryId: op.queryId,
  };

  const url = `${GQL_BASE}/${op.queryId}/CreateTweet`;
  const headers = await buildHeaders({ 'content-type': 'application/json' });

  const resp = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`CreateTweet HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
  return resp.json();
}

// ---- response shape helper ----
// X's TweetDetail response is deeply nested; we walk it to pull out replies.
function extractReplies(data, parentId) {
  const out = [];
  const seen = new Set();
  const stack = [data];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const c of node) stack.push(c);
      continue;
    }
    // Tweet result entries
    const tw = node.legacy || node.tweet?.legacy;
    const id = node.rest_id || node.tweet?.rest_id;
    if (tw && id && !seen.has(id) && id !== String(parentId)) {
      const inReplyTo = tw.in_reply_to_status_id_str;
      if (inReplyTo === String(parentId)) {
        seen.add(id);
        const userResult =
          node.core?.user_results?.result ||
          node.tweet?.core?.user_results?.result;
        out.push({
          id,
          text: tw.full_text || '',
          authorHandle: userResult?.legacy?.screen_name || null,
          authorName: userResult?.legacy?.name || null,
        });
      }
    }
    for (const k of Object.keys(node)) stack.push(node[k]);
  }
  return out;
}
