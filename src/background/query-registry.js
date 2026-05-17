// Tracks live X.com GraphQL operations seen on the page.
// For each operationName we remember:
//   - queryId          (from the URL, may rotate when X ships a frontend release)
//   - latest variables (raw JSON string) — used as a template for sending
//   - latest features  (raw JSON string)
//   - method           (GET | POST)
//   - url              (most recent full URL — handy for debugging)
//   - lastSeen         (timestamp)
//
// Headers (authorization, x-csrf-token, etc.) are tracked globally because
// they're per-session, not per-op.
import { storage } from '../core/storage.js';

const OPS_KEY = 'capture.ops';
const HEADERS_KEY = 'capture.headers';

// Headers that are safe (and necessary) to replay. Anything else is dropped.
// Notes:
//   - x-client-transaction-id is intentionally excluded: it's a per-request
//     anti-replay token, reusing it can get the request rejected.
//   - content-type is set per-call (only for POST), not stored globally.
const ALLOWED_HEADERS = new Set([
  'authorization',
  'x-csrf-token',
  'x-twitter-active-user',
  'x-twitter-auth-type',
  'x-twitter-client-language',
  'x-client-uuid',
]);

function pickHeaders(h) {
  const out = {};
  if (!h) return out;
  for (const k of Object.keys(h)) {
    const lk = k.toLowerCase();
    if (ALLOWED_HEADERS.has(lk)) out[lk] = h[k];
  }
  return out;
}

export async function recordObservation(rec) {
  if (!rec || !rec.operationName || !rec.queryId) return;

  // Update per-op record.
  await storage.update(OPS_KEY, (cur) => {
    const ops = cur || {};
    ops[rec.operationName] = {
      queryId: rec.queryId,
      method: rec.method || 'GET',
      url: rec.url,
      variables: rec.variables || null,
      features: rec.features || null,
      fieldToggles: rec.fieldToggles || null,
      body: rec.body || null,
      lastSeen: Date.now(),
    };
    return ops;
  }, {});

  // Update headers (merge — we never want to lose authorization seen earlier).
  const picked = pickHeaders(rec.headers);
  if (Object.keys(picked).length) {
    await storage.update(HEADERS_KEY, (cur) => {
      return { ...(cur || {}), ...picked, _updated: Date.now() };
    }, {});
  }
}

export async function getOp(name) {
  const ops = (await storage.get(OPS_KEY, {})) || {};
  return ops[name] || null;
}

export async function getAllOps() {
  return (await storage.get(OPS_KEY, {})) || {};
}

export async function getHeaders() {
  return (await storage.get(HEADERS_KEY, {})) || {};
}
