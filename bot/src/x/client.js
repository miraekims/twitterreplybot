// X.com HTTP client.
//
// Two transports, picked at runtime:
//
//   1. node-tls-client (preferred). Uses koffi to load Bogdanfinn's
//      tls-client shared library, which produces a Chrome-shaped TLS
//      Client Hello — JA3 fingerprint, HTTP/2 SETTINGS frame, header
//      order — that X.com's WAF accepts. This is the same approach the
//      prior project used (curl_cffi in Python).
//
//   2. Native Node fetch (fallback). Used only if node-tls-client failed
//      to import (rare; typically only happens when the package was
//      deliberately omitted from install). It will probably 404 on X
//      because Node's TLS handshake is recognised by Cloudflare-style
//      WAFs, but we don't crash — we log loudly and keep the bot alive
//      so other features (Telegram control, /stats, /logs) still work.
//
// API notes (these tripped me up — read before editing):
//   * Session is constructed with `new Session({ clientIdentifier, ... })`.
//   * Per-request cookies go in the `cookies` option as a flat
//     `Record<string,string>`. Do NOT touch the underlying tough-cookie
//     jar directly; the library manages it.
//   * `session.get`, `session.post` etc. return a Response with .ok,
//     .status, .body (already a string), .json(), .text().
//   * `execute()` is protected — call the verb methods.
import { logger } from '../core/logger.js';

const PUBLIC_BEARER =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D' +
  '1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const HOMEPAGE = 'https://x.com/home';
const GQL_BASE = 'https://x.com/i/api/graphql';

// Module-scoped: resolves once. v2 of node-tls-client requires an explicit
// initTLS() call to load the native koffi-backed library before any Session
// can be constructed; subsequent constructors reuse the same load.
let TlsSession = null;
let initTLSFn = null;
let destroyTLSFn = null;
let tlsTried = false;
async function getTlsSession() {
  if (tlsTried) return TlsSession;
  tlsTried = true;
  try {
    const mod = await import('node-tls-client');
    TlsSession = mod.Session || (mod.default && mod.default.Session);
    initTLSFn = mod.initTLS || (mod.default && mod.default.initTLS);
    destroyTLSFn = mod.destroyTLS || (mod.default && mod.default.destroyTLS);
    if (!TlsSession) {
      logger.warn('xclient', 'node-tls-client present but Session export missing; using vanilla fetch');
      TlsSession = null;
      return null;
    }
    if (initTLSFn) {
      await initTLSFn();
    }
    logger.info('xclient', 'using node-tls-client (Chrome TLS fingerprint)');
    // On graceful shutdown, release the native library.
    if (destroyTLSFn) {
      const cleanup = () => { try { destroyTLSFn(); } catch (_) {} };
      process.once('SIGINT', cleanup);
      process.once('SIGTERM', cleanup);
    }
  } catch (e) {
    logger.warn(
      'xclient',
      `node-tls-client not installed (${e.code || e.message}); ` +
      `using vanilla fetch — X will probably return 404`,
    );
    TlsSession = null;
  }
  return TlsSession;
}

// Chrome's actual header set + order. Order doesn't strictly matter when we
// hand a plain object to node-tls-client (it has its own ordering machinery),
// but we keep the "natural" Chrome order so vanilla-fetch fallback is at
// least less obviously a bot.
function chromeHeaders({ lang = 'en', isPost = false }) {
  const h = {
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'authorization': PUBLIC_BEARER,
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-client-language': lang,
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'referer': HOMEPAGE,
    'origin': 'https://x.com',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  if (isPost) h['content-type'] = 'application/json';
  return h;
}

export class XClient {
  constructor({ secrets, proxy = null, lang = 'en' }) {
    this.secrets = secrets;
    this.proxy = proxy;
    this.lang = lang;
    this._session = null;
    this._sessionInited = false;
  }

  async _ensureSession() {
    if (this._sessionInited) return;
    this._sessionInited = true;
    const Session = await getTlsSession();
    if (!Session) { this._session = null; return; }
    this._session = new Session({
      clientIdentifier: 'chrome_124',
      // Random TLS extension order: more important on actively-policed WAFs
      // than X, but cheap to enable.
      randomTlsExtensionOrder: true,
      // Default 30s — enough for slow X queries, short enough for backoff.
      timeout: 30_000,
      ...(this.proxy ? { proxy: this.proxy } : {}),
    });
  }

  // Both transports return the same shape: { status:number, text:string }.
  async _request(method, url, { body = null } = {}) {
    await this._ensureSession();
    const isPost = body !== null;
    const headers = chromeHeaders({ lang: this.lang, isPost });
    // X reads CSRF from the x-csrf-token header AND from the ct0 cookie.
    // Both must match; we pass the live cookie value in both places.
    headers['x-csrf-token'] = this.secrets.ct0;

    const cookies = {
      auth_token: this.secrets.auth_token,
      ct0: this.secrets.ct0,
    };

    if (this._session) {
      const opts = { headers, cookies };
      if (isPost) opts.body = JSON.stringify(body);
      let resp;
      if (method === 'GET') resp = await this._session.get(url, opts);
      else if (method === 'POST') resp = await this._session.post(url, opts);
      else throw new Error(`unsupported method ${method}`);
      return { status: resp.status, text: resp.body || '' };
    }

    // Fallback: native fetch. Almost certainly 404 on X but keeps the bot alive.
    const fetchHeaders = {
      ...headers,
      cookie: `auth_token=${this.secrets.auth_token}; ct0=${this.secrets.ct0}`,
    };
    const opts = { method, headers: fetchHeaders, redirect: 'follow' };
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
    // Strip pagination state but keep querySource/product as-is — X's
    // queryId is bound to the exact variable shape it was observed with.
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

// Walks a deeply-nested X response and collects top-level tweet results.
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
        hasUrls: !!(tw.entities?.urls?.length),
        authorHandle: u?.legacy?.screen_name || null,
        authorName: u?.legacy?.name || null,
        authorFollowers: u?.legacy?.followers_count || 0,
      });
    }
    for (const k of Object.keys(node)) stack.push(node[k]);
  }
  return out;
}
