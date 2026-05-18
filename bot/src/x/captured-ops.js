// Captured shapes of X.com GraphQL operations.
//
// Why captured shapes (not hardcoded queryIds): X's web frontend changes
// queryId and the `features` blob on every release. Hardcoding either dies
// within weeks. The browser extension at the repo root harvests these from
// live x.com traffic; you paste the latest snapshot into this file (or
// `bot/data/captured-ops.json` — see below).
//
// At runtime the bot prefers `bot/data/captured-ops.json` if present, falling
// back to the inline values below. So your workflow is:
//   1. Open the extension on x.com once, do one search and one tweet.
//   2. Open Status tab in the modal → Diagnostics → captured op JSON appears.
//   3. Paste it into bot/data/captured-ops.json (template provided).
//   4. Bot picks it up automatically on next campaign tick (no restart).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDE_PATH = path.resolve(__dirname, '../../data/captured-ops.json');

// Inline fallback. Update from extension whenever X breaks queryIds.
// Keep `body` null for GETs and the actual POST body for CreateTweet.
const FALLBACK = {
  SearchTimeline: null,
  CreateTweet: null,
  TweetDetail: null,
};

function loadOverride() {
  try {
    if (fs.existsSync(OVERRIDE_PATH)) {
      return JSON.parse(fs.readFileSync(OVERRIDE_PATH, 'utf8'));
    }
  } catch (_) {}
  return null;
}

// Hot-reload-able proxy: every property read consults the override file.
// This means the bot picks up new captured-ops.json without restart.
export const capturedOps = new Proxy({}, {
  get(_, key) {
    const override = loadOverride();
    if (override && override[key]) return override[key];
    return FALLBACK[key] || null;
  },
});
