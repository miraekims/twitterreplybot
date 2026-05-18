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
import { spawn } from 'node:child_process';
import { logger } from '../core/logger.js';
import { getCapturedTransactionId } from './captured-ops.js';

const CURL_BIN = 'curl_chrome116';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cachedCt = null;       // ClientTransaction instance
let cacheCreatedAt = 0;
let ClientTransaction = null;
let initAttempted = false;

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

// Fetch a URL using curl_chrome116 (same binary the bot uses for X API calls).
// Returns the response body as a string.
function curlGet(url) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '--max-time', '15', '-L', url];
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

// Find the ondemand.js URL from X's HTML. X embeds it as a <link> or <script>
// with a path like /ondemand.s.<hash>.js or similar pattern.
function findOndemandUrl(html) {
  // Pattern 1: script src containing "ondemand"
  const m1 = html.match(/src="(https?:\/\/[^"]*ondemand[^"]*\.js)"/i);
  if (m1) return m1[1];
  // Pattern 2: relative path
  const m2 = html.match(/src="(\/[^"]*ondemand[^"]*\.js)"/i);
  if (m2) return 'https://x.com' + m2[1];
  // Pattern 3: in link rel=preload
  const m3 = html.match(/href="(https?:\/\/[^"]*ondemand[^"]*\.js)"/i);
  if (m3) return m3[1];
  const m4 = html.match(/href="(\/[^"]*ondemand[^"]*\.js)"/i);
  if (m4) return 'https://x.com' + m4[1];
  return null;
}

async function refreshCache() {
  const CT = await loadLib();
  if (!CT) return false;

  try {
    // 1. Fetch x.com home HTML
    const html = await curlGet('https://x.com');
    if (!html || html.length < 1000) {
      logger.warn('txid', 'x.com HTML too short, skipping refresh');
      return false;
    }

    // 2. Find and fetch the ondemand script
    const ondemandUrl = findOndemandUrl(html);
    if (!ondemandUrl) {
      logger.warn('txid', 'could not find ondemand.js URL in x.com HTML');
      return false;
    }

    const ondemandJs = await curlGet(ondemandUrl);
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
export async function generateTransactionId(method, path) {
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
