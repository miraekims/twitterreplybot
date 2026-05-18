// X Reply Bot — standalone Node.js entry point.
//
// Architecture (matching the prior project's docs):
//   Telegram bot (long-poll)  ←→  this process  ←→  X.com (HTTPS via tls-client)
//                                    │
//                                    └→ SQLite (Fernet-encrypted cookies/proxies)
//
// One Node process supervises N "campaigns" (one per X account). Each campaign
// has its own loop, queue, rate limit and persona. Crashes are isolated per
// campaign — a dead worker doesn't take the bot down.
import 'dotenv/config';
import { startTelegram } from './telegram/bot.js';
import { db } from './core/db.js';
import { startSupervisor } from './core/supervisor.js';
import { logger } from './core/logger.js';

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
  requireEnv('ENCRYPTION_PASSPHRASE');

  await db.init();
  logger.info('boot', `db ready at ${db.path}`);

  // Start campaign supervisor — wakes up every 5s, runs ticks for active campaigns.
  startSupervisor();

  // Start Telegram bot (long-poll).
  startTelegram();

  process.on('SIGINT', async () => {
    logger.info('boot', 'SIGINT — shutting down');
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
