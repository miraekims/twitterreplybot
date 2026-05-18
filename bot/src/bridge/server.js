// WebSocket bridge server. The Chrome extension is a long-lived client; the
// bot is the long-lived server. The bot exposes RPC commands the extension
// can answer ("x.searchTimeline", "x.createTweet", "ping"), and the
// extension delivers two things back to the bot:
//
//   1. on connect: a "hello" with the X handle the user is logged into
//   2. periodic op-cache "summary" updates so /stats can show freshness
//
// Wire format: line-delimited JSON over WebSocket. Each frame is one
// envelope:
//
//   { type: 'rpc.req',   id, method, params }   bot  -> ext
//   { type: 'rpc.res',   id, result | error }   ext  -> bot
//   { type: 'hello',     handle, extVersion }   ext  -> bot   (once on connect)
//   { type: 'op.summary', ops: { name: { lastSeen, queryId } } }  ext -> bot
//   { type: 'ping' / 'pong' }                   either way
//
// Why custom framing and not socket.io: socket.io adds a heavy server
// dependency we don't need. Two dozen lines of JSON-over-ws is plenty.
//
// Auth: the first inbound frame from the extension MUST be a hello with the
// shared token from XBOT_BRIDGE_TOKEN. Anything else => disconnect. The
// listener binds to 0.0.0.0 inside the container; docker-compose only
// publishes 127.0.0.1:8787 on the host, so we never expose it to the LAN.
//
// Single-extension assumption: we keep at most ONE active connection. If a
// new extension connects (e.g. Chrome restarted, first connection went stale
// before its TCP timeout), we drop the old one. Multi-account would need
// per-handle routing here; explicit non-goal for now.
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { logger } from '../core/logger.js';

const RPC_TIMEOUT_MS = 30_000;       // stop waiting after this — extension probably stalled
const PING_INTERVAL_MS = 25_000;     // we expect a pong within next interval
const STALE_AFTER_MS = 60_000;       // mark connection as stale after this
const HELLO_TIMEOUT_MS = 5_000;      // disconnect if hello doesn't arrive in time

let wss = null;
let activeConn = null;               // { ws, handle, extVersion, opSummary, ... }
const pendingRpcs = new Map();       // id -> { resolve, reject, timer }

function safeSend(ws, payload) {
  try { ws.send(JSON.stringify(payload)); } catch (e) {
    logger.warn('bridge', `send failed: ${e.message}`);
  }
}

function rejectAllPending(reason) {
  for (const [, p] of pendingRpcs) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pendingRpcs.clear();
}

// Public API used by the bot's XClient and Telegram /stats.
export const bridge = {
  // True if at least one extension is connected, authenticated and not stale.
  isConnected() {
    if (!activeConn) return false;
    if (activeConn.ws.readyState !== 1 /* OPEN */) return false;
    if (Date.now() - activeConn.lastPongAt > STALE_AFTER_MS) return false;
    return true;
  },

  status() {
    if (!activeConn) {
      return { connected: false, handle: null, extVersion: null, opSummary: null,
               connectedAt: null, lastPongAt: null };
    }
    return {
      connected: bridge.isConnected(),
      handle: activeConn.handle,
      extVersion: activeConn.extVersion,
      opSummary: activeConn.opSummary,
      connectedAt: activeConn.connectedAt,
      lastPongAt: activeConn.lastPongAt,
    };
  },

  // Subscribers fire on hello / disconnect so /connect can resolve cleanly.
  onConnect(fn) { connectListeners.add(fn); return () => connectListeners.delete(fn); },
  onDisconnect(fn) { disconnectListeners.add(fn); return () => disconnectListeners.delete(fn); },

  // Issue an RPC to the connected extension. Throws if not connected, or
  // if the extension responds with an error, or if RPC_TIMEOUT_MS elapses.
  async call(method, params = {}) {
    if (!bridge.isConnected()) {
      const err = new Error('extension not connected to bot bridge');
      err.code = 'BRIDGE_DISCONNECTED';
      throw err;
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRpcs.delete(id);
        reject(new Error(`RPC ${method} timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      pendingRpcs.set(id, { resolve, reject, timer });
      safeSend(activeConn.ws, { type: 'rpc.req', id, method, params });
    });
  },
};

const connectListeners = new Set();
const disconnectListeners = new Set();

function fire(set, payload) {
  for (const fn of set) {
    try { fn(payload); } catch (e) { logger.warn('bridge', `listener: ${e.message}`); }
  }
}

export function startBridgeServer({ port = 8787, token } = {}) {
  if (!token) {
    // Without a token the listener is a free RCE for anyone on the host.
    // Refuse to start rather than silently degrade.
    throw new Error('XBOT_BRIDGE_TOKEN must be set in .env (any 16+ char random string)');
  }
  if (wss) return wss;
  wss = new WebSocketServer({ host: '0.0.0.0', port });
  wss.on('connection', (ws, req) => onConnection(ws, req, token));
  wss.on('error', (e) => logger.error('bridge', `server error: ${e.message}`));
  logger.info('bridge', `WebSocket bridge listening on 0.0.0.0:${port}`);
  return wss;
}

function onConnection(ws, req, expectedToken) {
  const peer = req.socket.remoteAddress;
  let authed = false;

  // Drop the connection if hello doesn't arrive in time. Otherwise an
  // attacker who finds the port can hold the slot open without sending a
  // valid token, blocking the real extension from connecting.
  const helloTimer = setTimeout(() => {
    if (!authed) {
      logger.warn('bridge', `connection from ${peer} did not send hello in ${HELLO_TIMEOUT_MS}ms — closing`);
      try { ws.close(4001, 'hello timeout'); } catch {}
    }
  }, HELLO_TIMEOUT_MS);

  ws.on('message', (raw) => {
    let frame;
    try { frame = JSON.parse(raw.toString('utf8')); }
    catch { logger.warn('bridge', `bad JSON from ${peer}`); return; }

    // Hello must come first and authenticate.
    if (!authed) {
      if (frame.type !== 'hello') {
        logger.warn('bridge', `non-hello first frame from ${peer}: ${frame.type}`);
        try { ws.close(4002, 'expected hello'); } catch {}
        return;
      }
      if (frame.token !== expectedToken) {
        logger.warn('bridge', `bad token from ${peer}`);
        try { ws.close(4003, 'bad token'); } catch {}
        return;
      }
      authed = true;
      clearTimeout(helloTimer);

      // Drop any stale connection — Chrome restart often leaves the old TCP
      // socket open until OS-level keepalive notices, which can be minutes.
      if (activeConn && activeConn.ws !== ws) {
        try { activeConn.ws.close(4004, 'replaced by newer connection'); } catch {}
        rejectAllPending('replaced by newer connection');
      }

      activeConn = {
        ws,
        handle: frame.handle || null,
        extVersion: frame.extVersion || null,
        opSummary: frame.opSummary || null,
        connectedAt: Date.now(),
        lastPongAt: Date.now(),
      };
      logger.info('bridge', `extension connected: @${frame.handle || '?'} (v${frame.extVersion || '?'})`);
      fire(connectListeners, bridge.status());
      // Start ping loop. We DO NOT use ws.ping() because the browser-side
      // WebSocket API doesn't expose pong frames; instead exchange JSON
      // ping/pong, which works in both directions.
      activeConn.pingTimer = setInterval(() => {
        if (ws.readyState !== 1) return;
        safeSend(ws, { type: 'ping' });
      }, PING_INTERVAL_MS);
      return;
    }

    // After hello: dispatch by frame type.
    if (frame.type === 'pong' || frame.type === 'ping') {
      if (activeConn) activeConn.lastPongAt = Date.now();
      // Mirror ping back so Chrome can also use this as its keepalive.
      if (frame.type === 'ping') safeSend(ws, { type: 'pong' });
      return;
    }

    if (frame.type === 'op.summary') {
      if (activeConn) activeConn.opSummary = frame.ops || null;
      return;
    }

    if (frame.type === 'rpc.res') {
      const p = pendingRpcs.get(frame.id);
      if (!p) {
        // Late response — extension may have retried after we already gave
        // up. Safe to ignore.
        return;
      }
      pendingRpcs.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.error) {
        const err = new Error(frame.error.message || 'extension RPC error');
        err.code = frame.error.code || null;
        err.status = frame.error.status || null;
        err.body = frame.error.body || null;
        p.reject(err);
      } else {
        p.resolve(frame.result);
      }
      return;
    }

    logger.warn('bridge', `unknown frame type: ${frame.type}`);
  });

  ws.on('close', (code, reason) => {
    clearTimeout(helloTimer);
    if (activeConn && activeConn.ws === ws) {
      clearInterval(activeConn.pingTimer);
      const handle = activeConn.handle;
      activeConn = null;
      rejectAllPending('extension disconnected');
      logger.warn('bridge', `extension disconnected: @${handle || '?'} code=${code} ${reason || ''}`);
      fire(disconnectListeners, { handle });
    }
  });

  ws.on('error', (e) => {
    logger.warn('bridge', `ws error: ${e.message}`);
  });
}
