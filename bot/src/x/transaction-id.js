// Auto-generates x-client-transaction-id for every X.com GraphQL request.
//
// The transaction-id is computed from:
//   1. The HTML of https://x.com (contains SVG animation paths with seed data)
//   2. An "ondemand" JS bundle from X (contains byte indices for the hash)
//   3. The HTTP method + path of the request being made
//
// We cache the HTML + ondemand script for 1 hour (X rotates them roughly
// every frontend release, which is at most once a day). If fetching fails,
// we fall back to the static value from captured-ops.json._headers.
//
// IMPORTANT: X returns near-empty HTML to unauthenticated requests. We MUST
// pass valid cookies when fetching x.com/home, otherwise we get nothing back.
//
// FAILURE MODE WE FIGHT HERE: xclienttransaction@0.0.2 ships a strict regex
// (variants of `(\w\[(\d{1,2})\],\s*16\))`) to extract KEY_BYTE indices from
// the ondemand bundle. When X's minifier shape changes (multi-char
// identifiers, switch to `Number("0x"+x[i])` / `+x[i]` instead of
// `parseInt(...,16)`, indices stored on a different object, etc.), the regex
// returns nothing and the constructor throws "Couldn't get KEY_BYTE indices".
//
// Strategy:
//   1. Subclass the original constructor (via `class extends`) and pre-
//      process the ondemand JS text inside our subclass constructor before
//      calling super(). This rewrites several known shapes back to the
//      canonical `(x[N],16)` form so the lib's regex matches. We need
//      `class extends` (not `function` + `.call`) because the lib ships
//      ClientTransaction as a real ES6 class — `.call(this,...)` throws.
//   2. On failure, ALWAYS dump fetched HTML + ondemand.js to
//      /app/data/last-txid-fetch/ — the only way to diagnose a regex miss
//      from outside the container is to actually look at the bundle. The
//      first 200 bytes of ondemand.js are also logged at WARN level so
//      `docker logs --tail` shows enough to recognise major shape changes
//      without copying files out.
//   3. Exponential 5min->4h backoff so we don't hammer the WAF every 5s
//      tick when we can't make progress.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logger } from '../core/logger.js';
import { getCapturedTransactionId } from './captured-ops.js';

const CURL_BIN = 'curl_chrome116';
const CACHE_TTL_MS = 60 * 60 * 1000;          // 1 hour
const MIN_RETRY_BACKOFF_MS = 5 * 60 * 1000;   // 5 min on first failure
const MAX_RETRY_BACKOFF_MS = 4 * 60 * 60_000; // cap at 4h
const FETCH_TIMEOUT_S = 15;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBUG_DUMP_DIR = path.resolve(__dirname, '../../data/last-txid-fetch');

let cachedCt = null;            // wrapped ClientTransaction instance
let cacheCreatedAt = 0;
let WrappedCT = null;
let initAttempted = false;

let _genCount = 0;
let _fallbackCount = 0;
let _cookies = null;            // populated by first authenticated caller

let lastRefreshAttemptAt = 0;
let consecutiveFailures = 0;
let _lastFailureMessage = null; // dedup repeated identical errors in logs
let _dumpedThisSession = false; // dump files only once per process (size guard)

// --- ondemand.js preprocessor ------------------------------------------------
//
// Best-effort: rewrite known minifier output shapes back to the canonical
// `parseInt(x[N], 16)` form the lib's regex expects. We do NOT require the
// match to be wrapped in `(...)` — the lib's regex matches `\w[N],16)`
// anywhere, so an unwrapped `,parseInt(abc[5],16)` after a comma is fine
// once we collapse the identifier.
//
// Patterns we handle (in order):
//
//   A. Multi-char identifier inside parseInt: `parseInt(abc[5], 16)`
//      → `parseInt(c[5],16)` (rename identifier to its last char,
//      whitespace removed).
//
//   B. `Number("0x"+x[i])`     → `parseInt(x[i],16)` (X 2025+ minifiers
//      sometimes emit Number+hex-string concat instead of parseInt).
//
//   C. `+("0x"+x[i])` or `+("0x"+abc[5])` → `parseInt(x[i],16)` (pure
//      unary-plus coercion variant).
//
// If after preprocessing the lib STILL can't find indices, X changed
// something deeper (e.g. indices are now stored on an object property or
// computed from a different source). Then we need to patch the lib itself
// or roll our own algorithm — neither is something the bot can do in the
// field. Hence the always-on debug dump.
function preprocessOndemand(src) {
  if (!src || typeof src !== 'string') return src;
  let s = src;

  // (A) Multi-char identifier in parseInt(..., 16). Anchor on `,16)` rather
  //     than a leading `(`, since the lib's regex doesn't require one.
  s = s.replace(
    /([A-Za-z_$][\w$]{1,})(\[\s*\d{1,3}\s*\])\s*,\s*16\s*\)/g,
    (_, ident, idx) => `${ident.slice(-1)}${idx.replace(/\s+/g, '')},16)`,
  );

  // (B) Number("0x"+x[i]) / Number("0x" + x[i])
  s = s.replace(
    /Number\(\s*["']0x["']\s*\+\s*([A-Za-z_$][\w$]*)(\[\s*\d{1,3}\s*\])\s*\)/g,
    (_, ident, idx) => `parseInt(${ident.slice(-1)}${idx.replace(/\s+/g, '')},16)`,
  );

  // (C) +("0x"+x[i]) — unary-plus coercion of "0x"+digit string
  s = s.replace(
    /\+\s*\(\s*["']0x["']\s*\+\s*([A-Za-z_$][\w$]*)(\[\s*\d{1,3}\s*\])\s*\)/g,
    (_, ident, idx) => `parseInt(${ident.slice(-1)}${idx.replace(/\s+/g, '')},16)`,
  );

  return s;
}

async function loadLib() {
  if (initAttempted) return WrappedCT;
  initAttempted = true;
  try {
    const mod = await import('xclienttransaction');
    const Original = mod.ClientTransaction
      || (mod.default && mod.default.ClientTransaction)
      || mod.default;
    if (typeof Original !== 'function') {
      logger.warn('txid', 'xclienttransaction loaded but ClientTransaction not found');
      return null;
    }
    // Constructor wrapper: rewrite ondemand text before delegating. We MUST
    // use `class extends` (not `function` + `.call`) because the lib ships
    // ClientTransaction as a real ES6 class — calling it without `new`
    // throws "Class constructor cannot be invoked without 'new'", which is
    // exactly what we hit on the first deploy of this fix.
    WrappedCT = class PatchedClientTransaction extends Original {
      constructor(html, ondemandJs) {
        super(html, preprocessOndemand(ondemandJs));
      }
    };
    logger.info('txid', 'xclienttransaction loaded (ondemand preprocessor active)');
  } catch (e) {
    logger.warn('txid', `xclienttransaction not available (${e.message}) — using static fallback`);
    WrappedCT = null;
  }
  return WrappedCT;
}

// curl-impersonate fetch (cookies attached if provided).
function curlGet(url, cookieHeader = null) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '--max-time', String(FETCH_TIMEOUT_S), '-L'];
    if (cookieHeader) args.push('-H', `cookie: ${cookieHeader}`);
    args.push(url);
    const child = spawn(CURL_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`curl ${code}: ${err.slice(0, 200)}`));
      else resolve(out);
    });
  });
}

// X embeds the ondemand URL in several shapes. Try them in order.
function findOndemandUrl(html) {
  const m1 = html.match(/(https?:\/\/[^"'\s]*ondemand[^"'\s]*\.js)/i);
  if (m1) return m1[1];
  const m2 = html.match(/(\/[^"'\s]*ondemand[^"'\s]*\.js)/i);
  if (m2) return 'https://abs.twimg.com' + m2[1];
  const m3 = html.match(/(https?:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"'\s]*\.js)/i);
  if (m3) return m3[1];
  return null;
}

// Always-on diagnostic dump on failure, capped to one set of files per
// process boot to avoid disk leak. The bot's data/ dir is a docker volume,
// so the dump survives a `docker compose down` — easy `docker cp` out.
function dumpForDebug(html, ondemandJs, ondemandUrl, reason) {
  if (_dumpedThisSession) return;
  _dumpedThisSession = true;
  try {
    fs.mkdirSync(DEBUG_DUMP_DIR, { recursive: true });
    if (html != null) fs.writeFileSync(path.join(DEBUG_DUMP_DIR, 'home.html'), html);
    if (ondemandJs != null) fs.writeFileSync(path.join(DEBUG_DUMP_DIR, 'ondemand.js'), ondemandJs);
    if (ondemandUrl) fs.writeFileSync(path.join(DEBUG_DUMP_DIR, 'ondemand.url'), ondemandUrl);
    fs.writeFileSync(path.join(DEBUG_DUMP_DIR, 'reason.txt'),
      `${new Date().toISOString()}\n${reason}\n`);
    logger.info(
      'txid',
      `debug dump written to ${DEBUG_DUMP_DIR}/ — ` +
      '`docker cp x-bot:/app/data/last-txid-fetch ./` to inspect',
    );
  } catch (e) {
    logger.warn('txid', `debug dump failed: ${e.message}`);
  }
}

// Note about logging shape: only emit a WARN line when the failure message
// changes, or every Nth identical failure. Otherwise repeated identical
// failures spam the logs at the supervisor's 5-second tick.
// Note about logging shape: only emit a WARN line when the failure message
// changes, or every Nth identical failure. Otherwise repeated identical
// failures spam the logs at the supervisor's 5-second tick.
function noteFailure(msg) {
  consecutiveFailures++;
  if (msg !== _lastFailureMessage || consecutiveFailures % 12 === 1) {
    const backoffMin = Math.round(currentBackoffMs() / 60000);
    logger.warn(
      'txid',
      `refresh failed (#${consecutiveFailures}, next attempt in ~${backoffMin}min): ${msg}`,
    );
    _lastFailureMessage = msg;
  }
}

function currentBackoffMs() {
  // 5min, 10min, 20min, 40min, 80min, 160min, capped at 4h.
  const exp = Math.min(consecutiveFailures, 6);
  return Math.min(MIN_RETRY_BACKOFF_MS * (2 ** Math.max(0, exp - 1)), MAX_RETRY_BACKOFF_MS);
}

async function refreshCache() {
  const CT = await loadLib();
  if (!CT) return false;
  if (!_cookies) {
    // Cold start — no cookies seen yet. The first request from the runner
    // will set them; until then we silently fall through to the static
    // header. This is normal for the first ~5 seconds after boot.
    return false;
  }

  let html = null;
  let ondemandJs = null;
  let ondemandUrl = null;
  try {
    html = await curlGet('https://x.com/home', _cookies);
    if (!html || html.length < 1000) {
      noteFailure(`x.com HTML too short (${html?.length || 0} bytes); cookies may be expired`);
      dumpForDebug(html, null, null, 'x.com HTML too short');
      return false;
    }

    ondemandUrl = findOndemandUrl(html);
    if (!ondemandUrl) {
      noteFailure('could not find ondemand.js URL in x.com HTML');
      dumpForDebug(html, null, null, 'no ondemand URL');
      return false;
    }

    ondemandJs = await curlGet(ondemandUrl, _cookies);
    if (!ondemandJs || ondemandJs.length < 100) {
      noteFailure(`ondemand.js too short (${ondemandJs?.length || 0} bytes)`);
      dumpForDebug(html, ondemandJs, ondemandUrl, 'ondemand.js too short');
      return false;
    }

    cachedCt = new CT(html, ondemandJs);
    cacheCreatedAt = Date.now();
    if (consecutiveFailures > 0) {
      logger.info('txid', `recovered after ${consecutiveFailures} failed attempt(s)`);
    } else {
      logger.info('txid', `cache refreshed (html=${html.length}b, ondemand=${ondemandJs.length}b)`);
    }
    consecutiveFailures = 0;
    _lastFailureMessage = null;
    return true;
  } catch (e) {
    noteFailure(e.message);
    // On a regex miss we get the LIBRARY's stack here, which usually doesn't
    // tell us anything useful. The dump (and the first 200b log line below)
    // is the actually-useful diagnostic.
    dumpForDebug(html, ondemandJs, ondemandUrl, e.message);
    if (ondemandJs && /KEY_BYTE/.test(e.message)) {
      // Print the head of the bundle so a human can spot major shape
      // changes from `docker logs` alone, no docker cp needed.
      const head = ondemandJs.slice(0, 200).replace(/\s+/g, ' ');
      logger.warn('txid', `ondemand.js head: ${head}…`);
      logger.warn(
        'txid',
        'preprocessor did not match. If this persists, please share ' +
        '/app/data/last-txid-fetch/ondemand.js — preprocessor needs an update',
      );
    }
    return false;
  }
}

async function maybeRefresh() {
  if (cachedCt && (Date.now() - cacheCreatedAt) < CACHE_TTL_MS) return;
  const now = Date.now();
  if (consecutiveFailures > 0 && now - lastRefreshAttemptAt < currentBackoffMs()) {
    return; // backing off
  }
  lastRefreshAttemptAt = now;
  await refreshCache();
}

// Generate a fresh transaction-id for the given method + path.
// Falls back to static value from captured-ops.json if generation fails.
// `cookies` param: "auth_token=XXX; ct0=XXX" — needed for authenticated fetch.
export async function generateTransactionId(method, path, cookies = null) {
  if (cookies) _cookies = cookies;

  await maybeRefresh();

  if (cachedCt) {
    try {
      const tid = cachedCt.generateTransactionId(method, path);
      if (tid) {
        _genCount++;
        return tid;
      }
    } catch (e) {
      noteFailure(`generation failed: ${e.message}`);
      cachedCt = null; // force a refresh next call
    }
  }

  const fallback = getCapturedTransactionId();
  _fallbackCount++;
  // Stats every 100 calls — quick way to spot silent regression to static
  // header in production without grepping.
  if ((_genCount + _fallbackCount) % 100 === 0) {
    logger.info('txid', `stats: generated=${_genCount}, fallback=${_fallbackCount}`);
  }
  return fallback || null;
}

// Test/diagnostic surface.
export function _txidStats() {
  return {
    generated: _genCount,
    fallback: _fallbackCount,
    consecutiveFailures,
    nextRetryMs: consecutiveFailures > 0
      ? Math.max(0, currentBackoffMs() - (Date.now() - lastRefreshAttemptAt))
      : 0,
    cached: !!cachedCt,
    cacheAgeMs: cachedCt ? Date.now() - cacheCreatedAt : null,
  };
}
