// X.com GraphQL client. Built on top of live observations from the page.
//
// Strategy: for each operation we replay the *same* request the official client
// issued, only swapping what we actually need to change. This way we don't have
// to keep a hardcoded list of GraphQL features (which drifts with every X
// frontend release).
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
    `Operation ${name} not captured yet. Trigger it once on x.com.`
  );
  return op;
}

function pickOneOf(names) {
  return Promise.all(names.map((n) => getOp(n))).then((arr) => {
    for (let i = 0; i < arr.length; i++) if (arr[i]) return { name: names[i], op: arr[i] };
    return null;
  });
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
    method: 'GET', credentials: 'include', headers,
  });
  if (!resp.ok) throw new Error(`TweetDetail HTTP ${resp.status}`);
  const data = await resp.json();
  return { replies: extractReplies(data, tweetId), raw: data };
}

// ---- SearchTimeline (find tweets matching a query) ----
// X frontend uses one of: SearchTimeline, ExploreSidebar, AdaptiveSearch...
// We try the common ones in order.
export async function searchTimeline({ query, count = 20, product = 'Latest' }) {
  const found = await pickOneOf(['SearchTimeline']);
  if (!found) {
    throw new Error(
      'SearchTimeline not captured yet. On x.com, type something into the ' +
      'search bar and press Enter once to warm it up.'
    );
  }
  const { op } = found;
  const baseVars = safeJsonParse(op.variables) || {};

  const variables = {
    ...baseVars,
    rawQuery: query,
    count,
    querySource: 'typed_query',
    product, // 'Top' | 'Latest' | 'People' | 'Photos' | 'Videos'
  };

  const url = new URL(`${GQL_BASE}/${op.queryId}/SearchTimeline`);
  url.searchParams.set('variables', JSON.stringify(variables));
  if (op.features) url.searchParams.set('features', op.features);
  if (op.fieldToggles) url.searchParams.set('fieldToggles', op.fieldToggles);

  const headers = await buildHeaders();
  const resp = await fetch(url.toString(), {
    method: 'GET', credentials: 'include', headers,
  });
  if (!resp.ok) throw new Error(`SearchTimeline HTTP ${resp.status}`);
  const data = await resp.json();
  return { tweets: extractTweets(data), raw: data };
}

// ---- CreateTweet (post a reply or a top-level tweet) ----
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
    method: 'POST', credentials: 'include', headers, body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    const err = new Error(`CreateTweet HTTP ${resp.status}: ${t.slice(0, 200)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

// ---- response walkers ----
// X responses are deeply nested; cheaper to walk than to encode every shape.

// Extract direct replies to a given parent tweet id.
function extractReplies(data, parentId) {
  const out = [];
  const seen = new Set();
  const stack = [data];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { for (const c of node) stack.push(c); continue; }
    const tw = node.legacy || node.tweet?.legacy;
    const id = node.rest_id || node.tweet?.rest_id;
    if (tw && id && !seen.has(id) && id !== String(parentId)) {
      if (tw.in_reply_to_status_id_str === String(parentId)) {
        seen.add(id);
        const u = node.core?.user_results?.result || node.tweet?.core?.user_results?.result;
        out.push({
          id, text: tw.full_text || '',
          authorHandle: u?.legacy?.screen_name || null,
          authorName: u?.legacy?.name || null,
        });
      }
    }
    for (const k of Object.keys(node)) stack.push(node[k]);
  }
  return out;
}

// Extract top-level tweets from a Search/Timeline response.
function extractTweets(data) {
  const out = [];
  const seen = new Set();
  const stack = [data];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { for (const c of node) stack.push(c); continue; }
    const tw = node.legacy;
    const id = node.rest_id;
    // Heuristic: a real tweet result has both rest_id and legacy.full_text.
    if (tw && id && typeof tw.full_text === 'string' && !seen.has(id)) {
      seen.add(id);
      const u = node.core?.user_results?.result;
      out.push({
        id,
        text: tw.full_text,
        createdAt: tw.created_at || null,
        favoriteCount: tw.favorite_count || 0,
        replyCount: tw.reply_count || 0,
        retweetCount: tw.retweet_count || 0,
        lang: tw.lang || null,
        isReply: !!tw.in_reply_to_status_id_str,
        isRetweet: !!tw.retweeted_status_result,
        hasUrls: !!(tw.entities && tw.entities.urls && tw.entities.urls.length),
        authorId: u?.rest_id || null,
        authorHandle: u?.legacy?.screen_name || null,
        authorName: u?.legacy?.name || null,
        authorFollowers: u?.legacy?.followers_count || 0,
      });
    }
    for (const k of Object.keys(node)) stack.push(node[k]);
  }
  return out;
}
