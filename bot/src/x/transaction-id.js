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
// `(\w\[(\d{1,2})\],\s*16\))` to extract KEY_BYTE indices from the ondemand
// bundle. When X's minifier shape changes (new identifier patterns, switch
// to `+("0x"+x[i])` instead of `parseInt(..., 16)`, etc.), the regex returns
// nothing and the constructor throws "Couldn't get KEY_BYTE indices". The
// previous version of this file tried to monkey-patch
// `ClientTransaction.prototype.getIndices` but that path was never invoked
// (in the published build, the method is captured as an instance arrow-fn
// in the constructor, before our prototype override is ever consulted). The
// SHORT error in your prod logs ("refresh failed: Couldn't get KEY_BYTE
// indices") instead of our longer patched message confirmed this.
//
// Strategy now:
//   1. Wrap the original constructor. Inside the wrapper we PRE-PROCESS the
//      ondemand JS text to canonicalise tokens that the lib's regex can
//      reliably match. This runs BEFORE the lib's constructor reads the
//      text, so it doesn't matter where getIndices is defined.
//   2. Keep an exponential backoff on refreshes — when the bundle truly
//      changes shape (algorithmic, not just identifier renames), nothing we
//      do here recovers it; we MUST stop hammering the WAF every 5 seconds
//      and let the static-header fallback carry traffic until someone
//      pastes a new captured op.
//   3. Optional debug dump: set XBOT_TXID_DEBUG=1 to write the last fetched
//      x.com HTML and ondemand.js to /app/data/last-txid-fetch/ so you can
//      inspect what shape X is currently serving without entering the box.
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

// --- ondemand.js preprocessor ------------------------------------------------
//
// The lib's regex needs `<single-word-char>[<digit>],16)` to find KEY_BYTE
// indices. Modern minifiers emit several variants we must canonicalise:
//
//   ab[5], 16)    → a[5],16)         (multi-char identifier; keep last char)
//   abc[12], 16)  → c[12],16)
//   x[3] , 16 )   → x[3],16)         (extra whitespace)
//
// We intentionally do NOT attempt to recover from algorithmic shape changes
// (e.g. switch to `+("0x"+x[i])`); those need a code update to the lib, and
// hammering retries against the WAF in the meantime is a fast track to a
// 401. In that case we let consecutiveFailures tick up and fall back to the
// static header from captured-ops.json.
function preprocessOndemand(src) {
  if (!src || typeof src !== 'string') return src;
  // Collapse `(  abc[NN] , 16 )` → `(c[NN],16)` while preserving overall
  // length roughly. We anchor on the opening `(` so the lib's regex, which
  // requires `(\w[..],16)` with no leading whitespace, can match. Capture
  // the LAST identifier char (idiomatic minified output single-char would
  // also match).
  return src.replace(
    /\(\s*([A-Za-z_$][\w$]{1,})(\[\s*\d{1,3}\s*\])\s*,\s*16\s*\)/g,
    (_, ident, idx) => `(${ident.slice(-1)}${idx.replace(/\s+/g, '')},16)`,
  );
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
    // Constructor wrapper: rewrite ondemand text before delegating. This
    // works even if the lib defines getIndices as an instance arrow-fn
    // because by then the constructor has already received our text.
    WrappedCT = function PatchedClientTransaction(html, ondemandJs) {
      const fixed = preprocessOndemand(ondemandJs);
      Original.call(this, html, fixed);
    };
    WrappedCT.prototype = Object.create(Original.prototype);
    WrappedCT.prototype.constructor = WrappedCT;
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

function maybeDumpDebug(html, ondemandJs, ondemandUrl) {
  if (process.env.XBOT_TXID_DEBUG !== '1') return;
  try {
    fs.mkdirSync(DEBUG_DUMP_DIR, { recursive: true });
    if (html != null) fs.writeFileSync(path.join(DEBUG_DUMP_DIR, 'home.html'), html);
    if (ondemandJs != null) fs.writeFileSync(path.join(DEBUG_DUMP_DIR, 'ondemand.js'), ondemandJs);
    if (ondemandUrl) fs.writeFileSync(path.join(DEBUG_DUMP_DIR, 'ondemand.url'), ondemandUrl);
    logger.info('txid', `debug dump written to ${DEBUG_DUMP_DIR}`);
  } catch (e) {
    logger.warn('txid', `debug dump failed: ${e.message}`);
  }
}

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
      maybeDumpDebug(html, null, null);
      return false;
    }

    ondemandUrl = findOndemandUrl(html);
    if (!ondemandUrl) {
      noteFailure('could not find ondemand.js URL in x.com HTML');
      maybeDumpDebug(html, null, null);
      return false;
    }

    ondemandJs = await curlGet(ondemandUrl, _cookies);
    if (!ondemandJs || ondemandJs.length < 100) {
      noteFailure(`ondemand.js too short (${ondemandJs?.length || 0} bytes)`);
      maybeDumpDebug(html, ondemandJs, ondemandUrl);
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
    maybeDumpDebug(html, ondemandJs, ondemandUrl);
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
