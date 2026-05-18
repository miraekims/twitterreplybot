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
// Diagnostics: how many times we've fallen through to static / null fallback.
// Surfaced once per 100 calls so prod logs aren't drowned but we can spot
// silent regression to the static header.
let _genCount = 0;
let _fallbackCount = 0;

// Stored cookies for authenticated fetches (set by first caller)
let _cookies = null;

// Permissive variants of the lib's INDICES_REGEX. The published v0.0.2 only
// matches single-letter variable names — `(\w\[(\d{1,2})\],\s*16\)` — which
// breaks against newer X ondemand bundles where the minifier emits multi-char
// identifiers (e.g. `(ab[5], 16)`). We try patterns from most-specific to
// least-specific and use the first that returns at least 2 matches (rowIndex
// + at least one keyByte index).
const INDICES_PATTERNS = [
  // Original lib pattern, kept for back-compat with old bundles.
  /(\(\w\[(\d{1,2})\],\s*16\))/g,
  // Multi-char identifier, 1–3 digit index. Covers post-2025 minified output.
  /\(([A-Za-z_$][\w$]*)\[(\d{1,3})\],\s*16\)/g,
  // Even looser: any identifier-ish thing followed by [N], 16.
  /\(([A-Za-z0-9_$]+)\[(\d{1,3})\]\s*,\s*16\s*\)/g,
];

function patchedGetIndices(ondemandFileResponse) {
  for (const re of INDICES_PATTERNS) {
    re.lastIndex = 0;
    const matches = [...ondemandFileResponse.matchAll(re)];
    if (matches.length >= 2) {
      const indices = matches.map((m) => parseInt(m[2], 10));
      return [indices[0], ...indices.slice(1)];
    }
  }
  // Last-resort: if we can find at least one `,16)` token, surface a more
  // informative error so the user knows the bundle shape changed entirely.
  const has16 = /,\s*16\s*\)/.test(ondemandFileResponse);
  throw new Error(
    `Couldn't get KEY_BYTE indices (ondemand=${ondemandFileResponse.length}b, ,16) tokens=${has16 ? 'present' : 'absent'})`,
  );
}

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
    // Monkey-patch getIndices on the prototype. The constructor calls
    // `this.getIndices(...)`, so a prototype override is picked up cleanly.
    // This is the smallest viable fix until upstream lands a permissive regex.
    ClientTransaction.prototype.getIndices = patchedGetIndices;
    logger.info('txid', 'xclienttransaction loaded (patched indices regex) — auto-generation enabled');
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
      if (tid) {
        _genCount++;
        return tid;
      }
    } catch (e) {
      logger.warn('txid', `generation failed: ${e.message}`);
    }
  }

  // Fallback: static value from captured-ops.json _headers
  const fallback = getCapturedTransactionId();
  _fallbackCount++;
  if ((_genCount + _fallbackCount) % 100 === 0) {
    logger.info('txid', `stats: generated=${_genCount}, fallback=${_fallbackCount} (last 100 batch)`);
  }
  if (fallback) return fallback;

  // Last resort: null (request will probably 404, but at least we tried)
  return null;
}
