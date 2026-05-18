// Tiny structured logger. Writes to stdout AND to db.logs (when campaign_id given).
import { db } from './db.js';

function fmt(ts) { return new Date(ts).toISOString().slice(11, 19); }
function line(level, scope, msg) {
  console.log(`[${fmt(Date.now())}] ${level.padEnd(5)} ${scope.padEnd(10)} ${msg}`);
}

export const logger = {
  info(scope, msg, campaign_id = null) { line('INFO', scope, msg); if (campaign_id) db.log(campaign_id, 'info', msg); },
  warn(scope, msg, campaign_id = null) { line('WARN', scope, msg); if (campaign_id) db.log(campaign_id, 'warn', msg); },
  error(scope, msg, campaign_id = null) { line('ERROR', scope, msg); if (campaign_id) db.log(campaign_id, 'error', msg); },
};
