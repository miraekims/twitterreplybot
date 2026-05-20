// X Reply Bot — standalone Node.js entry point.
//
// Architecture (post-bridge refactor):
//   Telegram (long-poll)  ←→  this process  ←→  Chrome extension (WebSocket)
//                                  │                       │
//                                  │                       └→ x.com / api.x.com
//                                  └→ SQLite (campaigns, logs)
//
// The bot no longer talks to x.com directly. The Chrome extension owns
// session state (cookies, queryId, x-client-transaction-id, TLS fingerprint)
// and receives RPC commands from us over a localhost WebSocket. See
// src/bridge/server.js for the wire protocol and src/x/client.js for the
// thin RPC adapter that runner.js uses.
import 'dotenv/config';
import { startTelegram } from './telegram/bot.js';
import { db } from './core/db.js';
import { startSupervisor } from './core/supervisor.js';
import { logger } from './core/logger.js';
import { aiActivationSummary } from './persona/persona.js';
import { startBridgeServer, bridge } from './bridge/server.js';
import { startPostsRunner } from './posts/scheduler.js';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: ${name} not set in .env. See .env.example.`);
    process.exit(1);
  }
  return v;
}

async function main() {
  requireEnv('TELEGRAM_BOT_TOKEN');
  requireEnv('TELEGRAM_ALLOWED_USERS');
  // ENCRYPTION_PASSPHRASE used to encrypt cookies in DB. Cookies live in
  // Chrome now, so this env is no longer required for new installs. We
  // still read it if present to keep old DB rows decryptable, but don't
  // hard-fail if missing.
  if (!process.env.ENCRYPTION_PASSPHRASE) {
    logger.info('boot', 'ENCRYPTION_PASSPHRASE not set (ok — cookies are owned by Chrome now)');
  }
  const bridgeToken = requireEnv('XBOT_BRIDGE_TOKEN');
  const bridgePort = parseInt(process.env.XBOT_BRIDGE_PORT || '8787', 10);

  await db.init();
  logger.info('boot', `db ready at ${db.path}`);
  logger.info('boot', `persona AI: ${aiActivationSummary()}`);

  startBridgeServer({ port: bridgePort, token: bridgeToken });

  // Surface bridge transitions in the main log so docker logs --tail makes
  // it easy to see when Chrome dies / wakes up. Telegram /stats and
  // runner.js already react in their own way.
  bridge.onConnect((s) => logger.info('boot', `bridge: ✓ extension connected as @${s.handle || '?'}`));
  bridge.onDisconnect((s) => logger.warn('boot', `bridge: ✗ extension disconnected (was @${s.handle || '?'})`));

  startSupervisor();
  startPostsRunner();
  startTelegram();

  process.on('SIGINT', () => {
    logger.info('boot', 'SIGINT — shutting down');
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
