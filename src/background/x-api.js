// X.com GraphQL client. Built on top of live observations from the page.
//
// Strategy: for each operation we replay the *same* request the official client
// issued, swapping only what we actually need to change. We never hardcode
// `queryId` or `features` — they're harvested from live traffic and persist
// across X frontend releases.
//
// Transport: requests are NOT issued from the service worker. From a SW
// `fetch()` carries `Origin: chrome-extension://...` and `Sec-Fetch-Site:
// cross-site`, which X.com responds to with HTTP 404 (an application-layer
// anti-bot rule). Instead we run the fetch via `chrome.scripting.executeScript`
// in the page MAIN world of an open x.com tab — that fetch is indistinguishable
// from a request made by X's own code (Origin: https://x.com, same-origin).
//
// Subtle bit: when we replay the captured `variables`, we strip pagination
// fields (`cursor`, `referrer`, ...). Otherwise the live X client may have
// last issued e.g. SearchTimeline with a cursor, and reusing that cursor
// against a new query yields HTTP 404.
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

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [url, init],
      func: async (u, i) => {
        try {
          const r = await fetch(u, i);
          const body = await r.text();
          const headers = {};
          r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
          return { ok: r.ok, status: r.status, statusText: r.statusText, body, headers };
        } catch (e) {
          return { error: String((e && e.message) || e) };
        }
      },
    });
  } catch (e) {
    const err = new Error(`executeScript failed: ${e && e.message ? e.message : String(e)}`);
    err.status = 0;
    err.url = url;
    throw err;
  }

  const result = results && results[0] && results[0].result;
  if (!result) {
    const err = new Error('executeScript returned no result (tab gone?)');
    err.status = 0; err.url = url;
    throw err;
  }
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
    // referrer/referrerPolicy intentionally omitted: when xFetch runs in the
    // page MAIN world, the browser fills these correctly from x.com itself.
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

// ---- TweetDetail (load replies under a tweet) ----
export async function tweetDetail({ tweetId }) {
  const op = await ensureOp('TweetDetail');
  const baseVars = cleanInheritedVars(safeJsonParse(op.variables));
  const variables = { ...baseVars, focalTweetId: String(tweetId) };
  const data = await gqlGet('TweetDetail', variables);
  return { replies: extractReplies(data, tweetId), raw: data };
}

// ---- SearchTimeline (find tweets matching a query) ----
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

  // Use the captured POST URL when available, so we always hit the exact
  // path/host X used.
  const url = op.url ? op.url : `${GQL_BASE}/${op.queryId}/CreateTweet`;
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
      `CreateTweet HTTP ${resp.status}: ${t.slice(0, 200)} (url=${new URL(url).pathname})`
    );
    err.status = resp.status;
    err.body = t;
    err.url = url;
    throw err;
  }
  return resp.json();
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
        isQuote: !!tw.is_quote_status,
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
