// Auto-generates x-client-transaction-id for every X.com GraphQL request.
//
// The transaction-id is computed from:
//   1. The HTML of https://x.com (contains SVG animation paths with seed data)
//   2. An "ondemand" JS bundle from X (contains byte indices for the hash)
//   3. The HTTP method + path of the request being made
//
// We cache the HTML + ondemand script for 1 hour (X rotates them roughly
// every frontend release, which is at most once a day). If fetching fails,
// we fall back to the static value from captured-ops.json.
//
// This eliminates the need to manually copy x-client-transaction-id from
// Chrome DevTools every few hours.
//
// IMPORTANT: X returns empty HTML to unauthenticated requests. We MUST pass
// valid cookies when fetching x.com/home, otherwise we get nothing back.
import { spawn } from 'node:child_process';
import { logger } from '../core/logger.js';
import { getCapturedTransactionId } from './captured-ops.js';

const CURL_BIN = 'curl_chrome116';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cachedCt = null;       // ClientTransaction instance
let cacheCreatedAt = 0;
let ClientTransaction = null;
let initAttempted = false;

// Stored cookies for authenticated fetches (set by first caller)
let _cookies = null;

async function loadLib() {
  if (initAttempted) return ClientTransaction;
  initAttempted = true;
  try {
    const mod = await import('xclienttransaction');
    ClientTransaction = mod.ClientTransaction || (mod.default && mod.default.ClientTransaction);
    if (!ClientTransaction) {
      logger.warn('txid', 'xclienttransaction loaded but ClientTransaction not found');
      return null;
    }
    logger.info('txid', 'xclienttransaction loaded — auto-generation enabled');
  } catch (e) {
    logger.warn('txid', `xclienttransaction not available (${e.message}) — using static fallback`);
    ClientTransaction = null;
  }
  return ClientTransaction;
}

// Fetch a URL using curl_chrome116 WITH cookies (X returns empty without them).
function curlGet(url, cookieHeader = null) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '--max-time', '15', '-L'];
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

// Find the ondemand.js URL from X's HTML. X embeds it in various forms:
//   - <script src="https://abs.twimg.com/responsive-web/client-web/ondemand.s.XXXX.js">
//   - <link rel="preload" href="/responsive-web/client-web/ondemand.s.XXXX.js">
//   - inline references in script tags
function findOndemandUrl(html) {
  // Pattern 1: any URL containing "ondemand" and ending in .js
  const m1 = html.match(/(https?:\/\/[^"'\s]*ondemand[^"'\s]*\.js)/i);
  if (m1) return m1[1];
  // Pattern 2: relative path with ondemand
  const m2 = html.match(/(\/[^"'\s]*ondemand[^"'\s]*\.js)/i);
  if (m2) return 'https://abs.twimg.com' + m2[1];
  // Pattern 3: look for any abs.twimg.com JS that might contain the indices
  // (fallback — X sometimes renames ondemand to something else)
  const m3 = html.match(/(https?:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"'\s]*\.js)/i);
  if (m3) return m3[1];
  return null;
}

async function refreshCache() {
  const CT = await loadLib();
  if (!CT) return false;
  if (!_cookies) {
    logger.warn('txid', 'no cookies available for authenticated fetch — cannot refresh');
    return false;
  }

  try {
    // 1. Fetch x.com home HTML WITH cookies (X returns empty without auth)
    const html = await curlGet('https://x.com/home', _cookies);
    if (!html || html.length < 1000) {
      logger.warn('txid', `x.com HTML too short (${html?.length || 0} bytes), skipping refresh`);
      return false;
    }

    // 2. Find and fetch the ondemand script
    const ondemandUrl = findOndemandUrl(html);
    if (!ondemandUrl) {
      logger.warn('txid', 'could not find ondemand.js URL in x.com HTML');
      return false;
    }

    const ondemandJs = await curlGet(ondemandUrl, _cookies);
    if (!ondemandJs || ondemandJs.length < 100) {
      logger.warn('txid', `ondemand.js too short (${ondemandJs?.length || 0} bytes)`);
      return false;
    }

    // 3. Create ClientTransaction instance
    cachedCt = new CT(html, ondemandJs);
    cacheCreatedAt = Date.now();
    logger.info('txid', `cache refreshed (html=${html.length}b, ondemand=${ondemandJs.length}b)`);
    return true;
  } catch (e) {
    logger.warn('txid', `refresh failed: ${e.message}`);
    return false;
  }
}

// Generate a fresh transaction-id for the given method + path.
// Falls back to static value from captured-ops.json if generation fails.
// `cookies` param: "auth_token=XXX; ct0=XXX" — needed for authenticated fetch.
export async function generateTransactionId(method, path, cookies = null) {
  // Store cookies for future cache refreshes
  if (cookies) _cookies = cookies;

  // Refresh cache if stale or missing
  if (!cachedCt || (Date.now() - cacheCreatedAt > CACHE_TTL_MS)) {
    await refreshCache();
  }

  if (cachedCt) {
    try {
      const tid = cachedCt.generateTransactionId(method, path);
      if (tid) return tid;
    } catch (e) {
      logger.warn('txid', `generation failed: ${e.message}`);
    }
  }

  // Fallback: static value from captured-ops.json _headers
  const fallback = getCapturedTransactionId();
  if (fallback) return fallback;

  // Last resort: null (request will probably 404, but at least we tried)
  return null;
}
