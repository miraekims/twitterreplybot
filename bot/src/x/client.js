// X.com HTTP client.
//
// Transport: curl-impersonate-chrome — produces a TLS Client Hello byte-
// for-byte identical to a real Chrome 116, including JA3, HTTP/2 SETTINGS
// frame and header order. We installed it via apt in the Dockerfile and
// shell out to it here. This is the same approach the prior project used
// (curl_cffi in Python is a Python wrapper around the same project).
//
// Why not node-tls-client: the npm package wraps Bogdanfinn's tls-client
// via koffi, but the install path is fragile (optional deps skipped on
// Apple Silicon, postinstall doesn't always fetch the right binary, v2
// requires explicit initTLS()). curl-impersonate is a single apt package
// that just works in our linux/amd64 container.
//
// Tradeoff: shelling out adds ~30-50ms per call vs. an in-process FFI.
// We do at most one call per tick (5 seconds), so it's irrelevant.
import { spawn } from 'node:child_process';
import { logger } from '../core/logger.js';
import { generateTransactionId } from './transaction-id.js';

const PUBLIC_BEARER =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D' +
  '1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const HOMEPAGE = 'https://x.com/home';
const GQL_BASE = 'https://x.com/i/api/graphql';

// Binary name from the Debian package. There are several variants
// (chrome116, chrome110, chrome99...); we go with 116 for stability — it's
// the most-tested, least likely to hit edge-case regressions.
const CURL_BIN = 'curl_chrome116';

let curlAvailable = null;
async function probeCurl() {
  if (curlAvailable !== null) return curlAvailable;
  curlAvailable = await new Promise((resolve) => {
    const p = spawn(CURL_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
  if (curlAvailable) {
    logger.info('xclient', `using ${CURL_BIN} (Chrome TLS fingerprint via curl-impersonate)`);
  } else {
    logger.warn(
      'xclient',
      `${CURL_BIN} not found; falling back to native fetch — X will likely 404. ` +
      `Are you running outside Docker? The Dockerfile installs curl-impersonate-chrome.`,
    );
  }
  return curlAvailable;
}

// Chrome's actual headers, in Chrome's actual order. Matched against a real
// Chrome 144 request captured from DevTools on 2026-05-18.
//
// Key findings from comparing bot vs real Chrome:
//   - Chrome sends content-type: application/json even on GET (X expects it)
//   - Chrome does NOT send origin on same-origin GET (only on POST)
//   - Chrome sends x-client-transaction-id (REQUIRED — X returns 404 without it)
//   - Chrome sends priority: u=1, i
function chromeHeaderArgs({ ct0, lang = 'en', isPost = false, transactionId = null }) {
  const headers = [
    ['accept', '*/*'],
    ['accept-language', 'en-US,en;q=0.9'],
    ['authorization', PUBLIC_BEARER],
    ['content-type', 'application/json'],
    ['priority', 'u=1, i'],
    ['referer', 'https://x.com/search?q=crypto&src=typed_query'],
    ['sec-ch-ua', '"Chromium";v="144", "Google Chrome";v="144", "Not-A.Brand";v="99"'],
    ['sec-ch-ua-mobile', '?0'],
    ['sec-ch-ua-platform', '"macOS"'],
    ['sec-fetch-dest', 'empty'],
    ['sec-fetch-mode', 'cors'],
    ['sec-fetch-site', 'same-origin'],
    ['user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'],
    ['x-client-transaction-id', transactionId],
    ['x-csrf-token', ct0],
    ['x-twitter-active-user', 'yes'],
    ['x-twitter-auth-type', 'OAuth2Session'],
    ['x-twitter-client-language', lang],
  ];
  // Only add origin on POST (Chrome doesn't send it on same-origin GET)
  if (isPost) headers.splice(5, 0, ['origin', 'https://x.com']);
  const args = [];
  for (const [k, v] of headers) {
    if (v != null) args.push('-H', `${k}: ${v}`);
  }
  return args;
}

// Run curl-impersonate, return {status, text}. Body via stdin to avoid
// shell-escaping headaches with arbitrary tweet text.
function runCurl({ method, url, headers, cookieHeader, body, proxy }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-sS',                  // silent + show errors (no progress meter)
      '-o', '-',              // body → stdout
      '-w', '%{http_code}',   // append status code at end of stdout
      '-X', method,
      '--max-time', '30',
      '-H', `cookie: ${cookieHeader}`,
      ...headers,
    ];
    if (proxy) args.push('-x', proxy);
    if (body !== null) {
      args.push('--data-binary', '@-');  // body from stdin
    }
    args.push(url);

    const child = spawn(CURL_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${CURL_BIN} exited ${code}: ${err.slice(0, 300)}`));
        return;
      }
      // Status code is the last 3 chars of stdout (from -w '%{http_code}').
      const status = parseInt(out.slice(-3), 10);
      const text = out.slice(0, -3);
      if (!Number.isFinite(status)) {
        reject(new Error(`could not parse status from curl output: ${out.slice(-50)}`));
        return;
      }
      resolve({ status, text });
    });
    if (body !== null) {
      child.stdin.write(body);
    }
    child.stdin.end();
  });
}

export class XClient {
  constructor({ secrets, proxy = null, lang = 'en' }) {
    this.secrets = secrets;
    this.proxy = proxy;
    this.lang = lang;
  }

  async _request(method, url, { body = null } = {}) {
    const ok = await probeCurl();
    const isPost = body !== null;
    const cookieHeader = `auth_token=${this.secrets.auth_token}; ct0=${this.secrets.ct0}`;

    // Generate fresh transaction-id for this specific request
    let urlPath;
    try { urlPath = new URL(url).pathname; } catch { urlPath = url; }
    const txId = await generateTransactionId(method, urlPath);

    const headers = chromeHeaderArgs({
      ct0: this.secrets.ct0, lang: this.lang, isPost,
      transactionId: txId,
    });

    if (ok) {
      const bodyStr = isPost ? JSON.stringify(body) : null;
      const result = await runCurl({
        method, url, headers, cookieHeader,
        body: bodyStr, proxy: this.proxy,
      });
      // Auto-refresh ct0 if X sends a new one in the response
      // (curl-impersonate doesn't expose set-cookie easily, so we
      // rely on the response body for now — ct0 refresh will be
      // handled via a periodic /home hit in a future iteration)
      return result;
    }

    // Fallback: vanilla Node fetch.
    const obj = {};
    for (let i = 0; i < headers.length; i += 2) {
      const kv = headers[i + 1];
      const idx = kv.indexOf(': ');
      if (idx > 0) obj[kv.slice(0, idx)] = kv.slice(idx + 2);
    }
    obj['cookie'] = cookieHeader;
    const opts = { method, headers: obj, redirect: 'follow' };
    if (isPost) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    const text = await r.text();
    return { status: r.status, text };
  }

  async healthCheck() {
    try {
      const r = await this._request('GET', 'https://x.com/i/api/1.1/account/settings.json');
      return { ok: r.status === 200, status: r.status };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async searchTimeline({ capturedOp, query }) {
    if (!capturedOp || !capturedOp.url) {
      throw new Error(
        'SearchTimeline shape not available. Paste from extension into bot/data/captured-ops.json.',
      );
    }
    const u = new URL(capturedOp.url);
    let baseVars = {};
    try {
      baseVars = JSON.parse(u.searchParams.get('variables') || '{}');
    } catch { /* leave empty */ }
    delete baseVars.cursor;
    delete baseVars.referrer;
    delete baseVars.controller_data;
    baseVars.rawQuery = query;
    u.searchParams.set('variables', JSON.stringify(baseVars));
    if (capturedOp.features && !u.searchParams.has('features')) {
      u.searchParams.set('features', capturedOp.features);
    }

    const r = await this._request('GET', u.toString());
    if (r.status !== 200) {
      const err = new Error(`SearchTimeline HTTP ${r.status}: ${(r.text || '').slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    return { tweets: extractTweets(JSON.parse(r.text)) };
  }

  async createTweet({ capturedOp, text, replyToTweetId }) {
    if (!capturedOp || !capturedOp.queryId) {
      throw new Error(
        'CreateTweet shape not available. Paste from extension into bot/data/captured-ops.json.',
      );
    }
    const baseBody = capturedOp.body ? JSON.parse(capturedOp.body) : {};
    const baseVars = baseBody.variables || {};
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
    const features =
      baseBody.features ||
      (capturedOp.features ? JSON.parse(capturedOp.features) : {});
    const body = { ...baseBody, variables, features, queryId: capturedOp.queryId };

    const url = capturedOp.url || `${GQL_BASE}/${capturedOp.queryId}/CreateTweet`;
    const r = await this._request('POST', url, { body });
    if (r.status !== 200) {
      const err = new Error(`CreateTweet HTTP ${r.status}: ${(r.text || '').slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    return JSON.parse(r.text);
  }
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
    if (tw && id && typeof tw.full_text === 'string' && !seen.has(id)) {
      seen.add(id);
      // User data can be nested in several places depending on the response shape
      const u =
        node.core?.user_results?.result?.legacy ||
        node.core?.user_results?.result ||
        node.tweet?.core?.user_results?.result?.legacy ||
        node.tweet?.core?.user_results?.result ||
        null;
      // Sometimes legacy is one level deeper
      const uLegacy = u?.legacy || u;
      const uResult = node.core?.user_results?.result || node.tweet?.core?.user_results?.result;
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
        hasUrls: !!(tw.entities?.urls?.length),
        authorHandle: uLegacy?.screen_name || uResult?.legacy?.screen_name || null,
        authorName: uLegacy?.name || uResult?.legacy?.name || null,
        authorFollowers: uLegacy?.followers_count || uResult?.legacy?.followers_count || 0,
      });
    }
    for (const k of Object.keys(node)) stack.push(node[k]);
  }
  return out;
}
