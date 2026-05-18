// X.com HTTP client.
//
// Two transports, picked at startup:
//   1. node-tls-client (preferred) — wraps bogdanfinn's Go library. Produces
//      a Chrome-shaped TLS Client Hello (JA3 + extension order + HTTP/2
//      SETTINGS frame). This is what your prior project used (curl_cffi in
//      Python). X.com's WAF reads the TLS fingerprint at handshake time, so
//      "vanilla Node fetch" is not enough on its own.
//   2. Native Node fetch (fallback) — used if node-tls-client failed to
//      install (Go binary download blocked, unsupported arch, etc.). It
//      will probably 404 on x.com, but the rest of the bot still runs and
//      a clear log line tells you why.
//
// Each XClient instance corresponds to ONE X account (one set of cookies).
import { logger } from '../core/logger.js';

const PUBLIC_BEARER =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D' +
  '1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const HOMEPAGE = 'https://x.com/home';
const GQL_BASE = 'https://x.com/i/api/graphql';

let TlsSession = null;
let tlsTried = false;
async function getTlsSession() {
  if (tlsTried) return TlsSession;
  tlsTried = true;
  try {
    const mod = await import('node-tls-client');
    TlsSession = mod.Session || mod.default?.Session;
    if (TlsSession) logger.info('xclient', 'using node-tls-client (Chrome TLS fingerprint)');
    else logger.warn('xclient', 'node-tls-client present but Session not exported; using fetch');
  } catch (e) {
    logger.warn('xclient', `node-tls-client not installed (${e.code || e.message}); using vanilla fetch — X may 404`);
    TlsSession = null;
  }
  return TlsSession;
}

function chromeHeaders({ ct0, lang = 'en', isPost = false }) {
  const h = {
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'authorization': PUBLIC_BEARER,
    'x-csrf-token': ct0,
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
    this._tls = null;
  }

  async _ensureTls() {
    if (this._tls !== null) return;
    const Session = await getTlsSession();
    if (!Session) { this._tls = false; return; }
    this._tls = new Session({
      clientIdentifier: 'chrome_124',
      randomTlsExtensionOrder: true,
      ...(this.proxy ? { proxies: { http: this.proxy, https: this.proxy } } : {}),
    });
    // Seed cookies on the session.
    const cookieHeader = `auth_token=${this.secrets.auth_token}; ct0=${this.secrets.ct0}`;
    this._cookieHeader = cookieHeader;
  }

  async _request(method, url, { body = null } = {}) {
    await this._ensureTls();
    const headers = chromeHeaders({
      ct0: this.secrets.ct0, lang: this.lang, isPost: body !== null,
    });

    if (this._tls) {
      // node-tls-client API
      headers['cookie'] = this._cookieHeader;
      const opts = { headers };
      if (body !== null) opts.body = JSON.stringify(body);
      const resp = await this._tls.execute(method, url, opts);
      const text = typeof resp.body === 'string' ? resp.body : (resp.body ? String(resp.body) : '');
      return { status: resp.status, text };
    }

    // Vanilla fetch fallback. Will likely 404 but at least gives a clear
    // signal in logs.
    headers['cookie'] = `auth_token=${this.secrets.auth_token}; ct0=${this.secrets.ct0}`;
    const opts = { method, headers, redirect: 'follow' };
    if (body !== null) opts.body = JSON.stringify(body);
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
      throw new Error('SearchTimeline shape not available. Paste from extension into bot/data/captured-ops.json.');
    }
    const u = new URL(capturedOp.url);
    let baseVars = {};
    try {
      baseVars = JSON.parse(u.searchParams.get('variables') || '{}');
    } catch {}
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
      const err = new Error(`SearchTimeline HTTP ${r.status}: ${r.text.slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    return { tweets: extractTweets(JSON.parse(r.text)) };
  }

  async createTweet({ capturedOp, text, replyToTweetId }) {
    if (!capturedOp || !capturedOp.queryId) {
      throw new Error('CreateTweet shape not available. Paste from extension into bot/data/captured-ops.json.');
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
    const features = baseBody.features || (capturedOp.features ? JSON.parse(capturedOp.features) : {});
    const body = { ...baseBody, variables, features, queryId: capturedOp.queryId };

    const url = capturedOp.url || `${GQL_BASE}/${capturedOp.queryId}/CreateTweet`;
    const r = await this._request('POST', url, { body });
    if (r.status !== 200) {
      const err = new Error(`CreateTweet HTTP ${r.status}: ${r.text.slice(0, 200)}`);
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
