// X.com GraphQL client. Built on top of live observations from the page.
//
// Strategy: for each operation we replay the *same* request the official client
// issued, swapping only what we actually need to change. We never hardcode
// `queryId` or `features` — they're harvested from live traffic and persist
// across X frontend releases.
//
// Transport: fetch routed through page-hook.js (MAIN world content_script).
// See xFetch() comment below for why executeScript({world:'MAIN'}) doesn't
// work on its own.
//
// Endpoint choice for autoreply: HomeTimeline, NOT SearchTimeline.
// SearchTimeline gets aggressive WAF rate-limiting because real users only
// hit it a few times a day; a bot doing 60 searches/h trips it inside 30
// min and the whole account starts getting 404s on /graphql/...SearchTimeline
// for hours. HomeTimeline is the every-scroll feed endpoint — every X
// client hits it constantly — so it's effectively rate-limited by what the
// product can tolerate end-users doing, not by what looks suspicious.
// Plus, when an account is well-curated (here: 1129 follows, all crypto),
// HomeTimeline IS the keyword stream we want — keyword filtering happens
// locally, X never sees what we're "searching" for.
import { getOp, getHeaders } from './query-registry.js';

const GQL_BASE = 'https://x.com/i/api/graphql';

// ---------- Page-world transport ----------

async function findXTab() {
  const tabs = await chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] });
  if (!tabs.length) return null;
  return tabs.find((t) => t.active) || tabs[0];
}

// Issue a fetch from the MAIN world of an x.com tab. Returns a tiny
// Response-like object: { ok, status, statusText, headers.get(), text(), json() }.
//
// Why we don't just chrome.scripting.executeScript({world:'MAIN', func: fetch}):
// X.com somehow detects that path and answers 404 with empty body even
// though the same URL+headers from devtools console returns 200. Best
// guess: each executeScript call creates a fresh JS context, and X
// patches the page's `fetch` with a wrapper (e.g. to inject
// x-client-transaction-id) that lives in the original page context.
// A fresh injected script doesn't see that wrapper, so its fetch is
// "raw" and X's WAF flags it.
//
// Workaround: route through page-hook.js. page-hook is a content_script
// that runs in MAIN world at document_start, BEFORE the X bundle, and
// inherits the same global as the X app code. We postMessage a
// 'fetch.req' to it; it does the actual fetch (now using the same fetch
// the X app patches) and postMessages back. The content script
// (`src/content/index.js`) bridges the chrome.runtime.sendMessage <->
// window.postMessage hop.
async function xFetch(url, init = {}) {
  const tab = await findXTab();
  if (!tab) {
    const err = new Error(
      'No x.com tab is open. Keep at least one x.com tab logged in while the bot runs.'
    );
    err.status = 0;
    err.url = url;
    throw err;
  }

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, {
      type: 'relay.fetch',
      payload: { url, init },
    });
  } catch (e) {
    const err = new Error(
      `relay sendMessage failed: ${e && e.message ? e.message : String(e)}` +
      ' (content script not loaded? page might need a reload after extension update)'
    );
    err.status = 0; err.url = url;
    throw err;
  }
  if (!resp || !resp.ok) {
    const err = new Error('relay response missing');
    err.status = 0; err.url = url;
    throw err;
  }
  const result = resp.data || {};
  if (result.error) {
    const err = new Error(`page fetch threw: ${result.error}`);
    err.status = 0; err.url = url;
    throw err;
  }

  return {
    ok: result.ok,
    status: result.status,
    statusText: result.statusText || '',
    headers: { get: (k) => result.headers[String(k).toLowerCase()] || null },
    text: async () => result.body,
    json: async () => JSON.parse(result.body),
  };
}

// Variables we never want to inherit from a captured request — they're either
// pagination state or session-specific noise.
const VARS_BLACKLIST = new Set([
  'cursor',
  'referrer',
  'controller_data',
]);

function safeJsonParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { return null; }
}

function cleanInheritedVars(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const k of Object.keys(obj)) {
    if (!VARS_BLACKLIST.has(k)) out[k] = obj[k];
  }
  return out;
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
  // X expects these even if not seen yet (some captures miss them).
  if (!headers['x-twitter-active-user']) headers['x-twitter-active-user'] = 'yes';
  if (!headers['x-twitter-auth-type']) headers['x-twitter-auth-type'] = 'OAuth2Session';
  if (!headers['x-twitter-client-language']) headers['x-twitter-client-language'] = 'en';
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

// Build the GET URL by starting from the captured URL (which has the exact
// path and query-string skeleton X used) and only swapping `variables`.
// This is more robust than reconstructing the path from queryId, since X
// occasionally serves the same operation under different hosts/paths
// (e.g. `x.com` vs `api.x.com`).
function buildGetUrl(op, opName, variables) {
  const base = op.url
    ? new URL(op.url)
    : new URL(`${GQL_BASE}/${op.queryId}/${opName}`);
  base.searchParams.set('variables', JSON.stringify(variables));
  if (op.features && !base.searchParams.has('features')) {
    base.searchParams.set('features', op.features);
  }
  if (op.fieldToggles && !base.searchParams.has('fieldToggles')) {
    base.searchParams.set('fieldToggles', op.fieldToggles);
  }
  return base;
}

async function gqlGet(opName, variables) {
  const op = await ensureOp(opName);
  const url = buildGetUrl(op, opName, variables);
  const headers = await buildHeaders();

  const resp = await xFetch(url.toString(), {
    method: 'GET',
    credentials: 'include',
    headers,
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    const err = new Error(
      `${opName} HTTP ${resp.status}: ${t.slice(0, 200)} (url=${url.pathname})`
    );
    err.status = resp.status;
    err.body = t;
    err.url = url.toString();
    throw err;
  }
  return resp.json();
}

// Same as gqlGet but for POST ops (CreateTweet etc).
async function gqlPost(opName, body) {
  const op = await ensureOp(opName);
  const url = op.url ? op.url : `${GQL_BASE}/${op.queryId}/${opName}`;
  const headers = await buildHeaders({ 'content-type': 'application/json' });
  const resp = await xFetch(url, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    const err = new Error(
      `${opName} HTTP ${resp.status}: ${t.slice(0, 200)} (url=${new URL(url).pathname})`
    );
    err.status = resp.status;
    err.body = t;
    err.url = url;
    throw err;
  }
  return resp.json();
}

// ---- TweetDetail (load replies under a tweet) ----
export async function tweetDetail({ tweetId }) {
  const op = await ensureOp('TweetDetail');
  const baseVars = cleanInheritedVars(safeJsonParse(op.variables));
  const variables = { ...baseVars, focalTweetId: String(tweetId) };
  const data = await gqlGet('TweetDetail', variables);
  return { replies: extractReplies(data, tweetId), raw: data };
}

// ---- HomeTimeline (the user's "Following" / "For You" feed) ----
//
// Returns up to ~40 fresh tweets from the user's own home feed plus a
// `nextCursor` for paginating deeper. The runner uses this instead of
// SearchTimeline because:
//   1. It's the same endpoint X-frontend hits every time you scroll.
//      Indistinguishable from organic activity at the WAF level.
//   2. A well-curated account already filters topics through the people
//      it follows. Local keyword filtering on tweet.text is enough.
//   3. No persistent-query input quirks like rawQuery/querySource.
//
// Both operationNames X uses live in the wild are tried: HomeTimeline
// (Following) and HomeLatestTimeline. We pick whichever the user
// triggered most recently — the modal's StatusTab will say which.
export async function homeTimeline({ cursor = null, count = 40 } = {}) {
  const op = (await getOp('HomeTimeline')) || (await getOp('HomeLatestTimeline'));
  if (!op) {
    throw new Error(
      'HomeTimeline op not captured yet. Open x.com and scroll the home feed once.',
    );
  }
  const opName = op.queryId
    ? (op.url && /HomeLatest/.test(op.url) ? 'HomeLatestTimeline' : 'HomeTimeline')
    : 'HomeTimeline';

  const baseVars = cleanInheritedVars(safeJsonParse(op.variables));
  const variables = { ...baseVars, count };
  // X requires these fields; omitting them yields 422 GRAPHQL_VALIDATION_FAILED.
  if (variables.includePromotedContent == null) variables.includePromotedContent = true;
  if (variables.latestControlAvailable == null) variables.latestControlAvailable = true;
  if (cursor) variables.cursor = cursor;

  const data = await gqlGetExplicit(op, opName, variables);
  return {
    tweets: extractTweets(data),
    nextCursor: extractNextCursor(data),
    raw: data,
  };
}

// HomeTimeline-specific gqlGet that takes the op object directly so we
// can route between HomeTimeline and HomeLatestTimeline without an extra
// ensureOp() lookup.
async function gqlGetExplicit(op, opName, variables) {
  const url = buildGetUrl(op, opName, variables);
  const headers = await buildHeaders();
  const resp = await xFetch(url.toString(), {
    method: 'GET',
    credentials: 'include',
    headers,
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    const err = new Error(
      `${opName} HTTP ${resp.status}: ${t.slice(0, 200)} (url=${url.pathname})`
    );
    err.status = resp.status;
    err.body = t;
    err.url = url.toString();
    throw err;
  }
  return resp.json();
}

// ---- SearchTimeline (kept for the modal "Comments" tab) ----
// Important: we keep the captured `querySource` and `product` as-is. X's
// SearchTimeline queryId is bound to the *exact* shape of variables it was
// observed with — overriding `querySource` ("typed_query" vs "recent_search_click")
// or `product` ("Latest" vs "Top") yields HTTP 404 even with a perfect URL,
// because the persistent query expects a specific input.
export async function searchTimeline({ query }) {
  const op = await ensureOp('SearchTimeline');
  const baseVars = cleanInheritedVars(safeJsonParse(op.variables));
  const variables = { ...baseVars, rawQuery: query };
  const data = await gqlGet('SearchTimeline', variables);
  return { tweets: extractTweets(data), raw: data };
}

// ---- CreateTweet (post a reply or a top-level tweet) ----
export async function createTweet({ text, replyToTweetId }) {
  const op = await ensureOp('CreateTweet');
  const baseBody = safeJsonParse(op.body) || {};
  const baseVars = cleanInheritedVars(baseBody.variables);
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

  return gqlPost('CreateTweet', body);
}

// ---- response walkers ----
// X responses are deeply nested; cheaper to walk than to encode every shape.

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
        const uLegacy = u?.legacy || null;
        out.push({
          id, text: tw.full_text || '',
          authorHandle: uLegacy?.screen_name || u?.core?.screen_name || null,
          authorName: uLegacy?.name || u?.core?.name || null,
          authorFollowers: uLegacy?.followers_count || u?.followers_count || 0,
          authorBio: uLegacy?.description || u?.core?.description || u?.description || '',
          favoriteCount: tw.favorite_count || 0,
          createdAt: tw.created_at || null,
        });
      }
    }
    for (const k of Object.keys(node)) stack.push(node[k]);
  }
  return out;
}

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
      // Resolve author from any of the shapes X has used.
      // Pre-2024: result.legacy.{screen_name,name,followers_count}
      // 2024+:    result.core.{screen_name,name} (legacy is being deprecated)
      const userResult =
        node.core?.user_results?.result ||
        node.tweet?.core?.user_results?.result ||
        null;
      const u = userResult?.legacy || null;
      const uCore = userResult?.core || null;
      const handle = u?.screen_name || uCore?.screen_name || userResult?.screen_name || null;
      const name = u?.name || uCore?.name || userResult?.name || null;
      const followers = u?.followers_count || userResult?.followers_count || 0;
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
        isQuote: !!tw.is_quote_status,
        hasUrls: !!(tw.entities && tw.entities.urls && tw.entities.urls.length),
        authorId: userResult?.rest_id || null,
        authorHandle: handle,
        authorName: name,
        authorFollowers: followers,
        authorBio: u?.description || uCore?.description || userResult?.description || '',
      });
    }
    for (const k of Object.keys(node)) stack.push(node[k]);
  }
  return out;
}

// X paginates HomeTimeline via opaque cursors embedded in 'TimelineTimelineCursor'
// entries. We want the "Bottom" cursor — that's the "load more old tweets"
// pointer, the right thing to use for incremental scrolling.
function extractNextCursor(data) {
  let bottom = null;
  const stack = [data];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { for (const c of node) stack.push(c); continue; }
    if (node.cursorType === 'Bottom' && typeof node.value === 'string') {
      bottom = node.value;
    }
    for (const k of Object.keys(node)) stack.push(node[k]);
  }
  return bottom;
}
