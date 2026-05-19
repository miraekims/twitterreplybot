// WebSocket client for the bot bridge. Lives in the service worker.
//
// The bot is the long-lived server (Docker, restart=unless-stopped); this
// client is the long-lived client (until Chrome closes). We own the
// reconnect logic.
//
// Wire format mirrors src/bridge/server.js in the bot:
//
//   ext  -> bot:  { type: 'hello',     token, handle, extVersion, opSummary }
//   bot  -> ext:  { type: 'rpc.req',   id, method, params }
//   ext  -> bot:  { type: 'rpc.res',   id, result | error }
//   either way:   { type: 'ping' / 'pong' }
//   ext  -> bot:  { type: 'op.summary', ops }   (push on capture changes)
//
// MV3 service worker realities and the reconnect-loop fix
// -------------------------------------------------------
//
// We hit a feedback loop where the SW reconnected to the bridge every
// ~2 seconds (visible in the bot log as a stream of "extension
// connected" / "replaced by newer connection"). Trace:
//
//   1. SW boots, opens ws₁, registers it as module-level `ws`
//   2. SW idles. Despite the live WebSocket the SW can still get
//      suspended between bursts of activity (the 30s idle timer is
//      supposed to be paused for active WS but in practice MV3
//      sometimes evicts anyway).
//   3. SW wakes on next inbound RPC. Module re-imports → `ws = null`.
//   4. startBridge() schedules a fresh connect → ws₂ opens.
//   5. Bot sees a second connection from the same client and closes
//      ws₁ with code 4004 ("replaced by newer connection").
//   6. ws₁'s close handler runs in the extension. The OLD code
//      blindly cleared module state — but `ws` was already pointing
//      at ws₂. We just nulled out the live socket.
//   7. scheduleReconnect → ws₃ → goto 5. Loop.
//
// Two fixes:
//   - Each socket carries an identity (the local `socket` var). Its
//     close handler only mutates module state if `ws === socket`. If
//     a newer connect already swapped in another ws, the close is a
//     no-op for module state.
//   - scheduleReconnect bails out if a healthy ws is already there,
//     not just if a reconnect is already pending. So the wake-up
//     `startBridge()` doesn't open a needless second connection.
//
// Backoff on real failures: 1s, 2s, 4s, 8s, ... capped at 30s. Resets
// on a successful hello.

import { storage } from '../core/storage.js';
import { getAllOps } from './query-registry.js';
import { warmupXcom } from './keepalive.js';

const SETTINGS_KEY = 'bridge.settings';
const STATUS_KEY = 'bridge.status';

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 25_000;

let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let pingTimer = null;
let opSummaryUnsub = null;        // detach storage listener on disconnect
let lastPushedSummary = null;     // dedup repeated identical pushes
let _rpcHandler = null;           // set by index.js — handles inbound rpc.req

const DEFAULTS = {
  url: 'ws://host.docker.internal:8787',
  token: '',
};

export async function getBridgeSettings() {
  const cur = (await storage.get(SETTINGS_KEY, {})) || {};
  return { ...DEFAULTS, ...cur };
}

export async function setBridgeSettings(patch) {
  const next = { ...(await getBridgeSettings()), ...(patch || {}) };
  await storage.set(SETTINGS_KEY, next);
  // Force-reconnect with new settings.
  disconnect();
  scheduleReconnect(0);
  return next;
}

export async function getBridgeStatus() {
  return (await storage.get(STATUS_KEY, { connected: false })) || { connected: false };
}

async function setStatus(patch) {
  const cur = await getBridgeStatus();
  await storage.set(STATUS_KEY, { ...cur, ...patch, _updated: Date.now() });
}

// Called once from background/index.js, with a function that can answer
// inbound RPC requests (typically `dispatchRpc` in index.js routing to
// x-api.js handlers).
export function startBridge(rpcHandler) {
  _rpcHandler = rpcHandler;
  scheduleReconnect(0);
}

export function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (opSummaryUnsub) { try { opSummaryUnsub(); } catch {} opSummaryUnsub = null; }
  if (ws) {
    try { ws.close(1000, 'manual'); } catch {}
    ws = null;
  }
}

// Public — used by keepalive watchdog. If we're already healthy, no-op.
export function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (ws && ws.readyState === WebSocket.CONNECTING) return;
  scheduleReconnect(0);
}

function scheduleReconnect(delayMs) {
  // Bail if a healthy or pending socket already exists. Without this
  // a transient call to scheduleReconnect (typically from startBridge
  // on every SW wake-up) would try to open a second ws while ws₁ is
  // still alive — the bot then evicts ws₁ → ws₁'s close handler ran
  // (in the old code) → infinite reconnect loop.
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((e) => {
      console.warn('[xbot bridge] connect failed:', e && e.message);
      reconnectAttempt++;
      const next = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** reconnectAttempt);
      scheduleReconnect(next);
    });
  }, delayMs);
}

async function readLoggedInHandle() {
  // ct0 is set on every X session; screen_name lives in cookies too but is
  // sometimes URL-encoded. Read both, prefer twid which decodes to "u=ID"
  // and is a stable identifier (we only use the handle for display so a
  // failed read here is fine — the bot will show "?" until next session).
  try {
    const sn = await chrome.cookies.get({ url: 'https://x.com', name: 'screen_name' });
    if (sn && sn.value) return decodeURIComponent(sn.value);
  } catch {}
  try {
    // Fallback — twid is `u%3D<id>`; not a handle but unique. Better than null.
    const t = await chrome.cookies.get({ url: 'https://x.com', name: 'twid' });
    if (t && t.value) return decodeURIComponent(t.value);
  } catch {}
  return null;
}

async function buildOpSummary() {
  const ops = await getAllOps();
  const out = {};
  for (const name of Object.keys(ops)) {
    out[name] = { lastSeen: ops[name].lastSeen, queryId: ops[name].queryId };
  }
  return out;
}

async function connect() {
  const { url, token } = await getBridgeSettings();
  if (!token) {
    console.warn('[xbot bridge] no token configured — open extension Options to set it');
    await setStatus({ connected: false, lastError: 'no token configured' });
    // No point retrying every second when there's no token. Long backoff.
    reconnectAttempt = 5;
    return;
  }

  console.log(`[xbot bridge] connecting to ${url} ...`);
  await setStatus({ connected: false, connecting: true, lastError: null });

  // `socket` is the per-attempt identity. Every event handler on this
  // socket checks `ws === socket` before mutating module state, so a
  // delayed close from a previous attempt cannot null out a healthy
  // newer ws.
  const socket = new WebSocket(url);
  ws = socket;

  socket.addEventListener('open', async () => {
    if (ws !== socket) return; // we've already been replaced
    console.log('[xbot bridge] socket open, sending hello');
    const handle = await readLoggedInHandle();
    const extVersion = chrome.runtime.getManifest().version;
    const opSummary = await buildOpSummary();
    safeSend(socket, { type: 'hello', token, handle, extVersion, opSummary });

    reconnectAttempt = 0;
    await setStatus({
      connected: true, connecting: false, lastError: null,
      handle, extVersion, connectedAt: Date.now(),
    });

    // Keepalive ping. The bot also pings us; this is belt-and-suspenders.
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => safeSend(socket, { type: 'ping' }), PING_INTERVAL_MS);

    // Push op-summary updates on every new capture. Coarse but cheap —
    // chrome.storage onChange fires on each recordObservation.
    if (opSummaryUnsub) opSummaryUnsub();
    opSummaryUnsub = subscribeToOpUpdates(socket);

    // Auto-warmup on connect. If the user doesn't currently have an
    // x.com tab open, open one in the background so the page-hook
    // captures HomeTimeline / UserByScreenName / etc. The autoreply
    // runner uses HomeTimeline; without a fresh observation here, its
    // very first feed scan after a fresh Chrome session would throw
    // "HomeTimeline not captured yet". The function debounces
    // internally (won't refire within 5min) so this is safe even on
    // reconnect storms.
    warmupXcom('bridge.connect').catch((e) => {
      console.warn('[xbot bridge] warmup failed:', e && e.message);
    });
  });

  socket.addEventListener('message', async (ev) => {
    let frame;
    try { frame = JSON.parse(ev.data); }
    catch { console.warn('[xbot bridge] bad JSON from server'); return; }

    if (frame.type === 'pong' || frame.type === 'ping') {
      if (frame.type === 'ping') safeSend(socket, { type: 'pong' });
      return;
    }

    if (frame.type === 'rpc.req') {
      handleRpc(socket, frame).catch((e) => {
        console.error('[xbot bridge] rpc handler crashed:', e);
        safeSend(socket, {
          type: 'rpc.res', id: frame.id,
          error: { message: e && e.message ? e.message : String(e) },
        });
      });
      return;
    }
  });

  socket.addEventListener('close', async (ev) => {
    const reason = `code=${ev.code} ${ev.reason || ''}`.trim();
    // CRITICAL: only act on this close if we're still the current
    // socket. If a newer connect() already swapped in another ws,
    // leave module state alone — otherwise we'd null out the live
    // ws pointer and trigger another reconnect.
    if (ws !== socket) {
      console.log(`[xbot bridge] stale socket closed (${reason}); ignoring`);
      return;
    }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (opSummaryUnsub) { try { opSummaryUnsub(); } catch {} opSummaryUnsub = null; }
    ws = null;
    console.warn(`[xbot bridge] socket closed: ${reason}`);
    await setStatus({ connected: false, connecting: false, lastError: reason });

    // 4001-4003 are auth/protocol errors from the server — backoff long.
    // Network disconnects are fast to retry. 4004 ("replaced") never
    // arrives here because the replaced socket is the OLD one and its
    // close is filtered above.
    const longBackoff = ev.code >= 4001 && ev.code <= 4003;
    if (longBackoff) {
      reconnectAttempt = Math.max(reconnectAttempt, 4); // ~16s+ delay
    } else {
      reconnectAttempt++;
    }
    const next = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** reconnectAttempt);
    scheduleReconnect(next);
  });

  socket.addEventListener('error', (e) => {
    console.warn('[xbot bridge] socket error', e && (e.message || ''));
    // close handler will fire next; do not reconnect from here.
  });
}

function safeSend(socket, obj) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try { socket.send(JSON.stringify(obj)); return true; }
  catch (e) { console.warn('[xbot bridge] send failed:', e.message); return false; }
}

async function handleRpc(socket, req) {
  if (!_rpcHandler) {
    safeSend(socket, { type: 'rpc.res', id: req.id, error: { message: 'no rpc handler registered' } });
    return;
  }
  try {
    const result = await _rpcHandler(req.method, req.params || {});
    safeSend(socket, { type: 'rpc.res', id: req.id, result });
  } catch (e) {
    safeSend(socket, {
      type: 'rpc.res', id: req.id,
      error: {
        message: e && e.message ? e.message : String(e),
        status: e && e.status,
        body: e && typeof e.body === 'string' ? e.body.slice(0, 500) : undefined,
      },
    });
  }
}

// Listen for op-cache changes and push a summary up the WS. We coalesce
// rapid-fire updates with a 1s debounce — every page request doesn't need
// to push a frame.
function subscribeToOpUpdates(socket) {
  let pending = false;
  const handler = async (changes, area) => {
    if (area !== 'local') return;
    if (!('capture.ops' in changes) && !('capture.headers' in changes)) return;
    if (pending) return;
    pending = true;
    setTimeout(async () => {
      pending = false;
      const ops = await buildOpSummary();
      const json = JSON.stringify(ops);
      if (json === lastPushedSummary) return;
      lastPushedSummary = json;
      safeSend(socket, { type: 'op.summary', ops });
    }, 1000);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
