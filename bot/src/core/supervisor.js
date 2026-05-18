// Wakes every 5s, runs one tick for each running campaign.
// Each tick is at most one X.com action. State lives in the DB so an OS-level
// crash + restart picks up where we left off.
import { db } from './db.js';
import { logger } from './logger.js';
import { tickCampaign } from '../campaign/runner.js';

const TICK_INTERVAL_MS = 5000;
const inflight = new Set(); // campaign ids currently being ticked

export function startSupervisor() {
  setInterval(() => {
    const active = db.campaignsActive();
    for (const c of active) {
      if (inflight.has(c.id)) continue;
      inflight.add(c.id);
      tickCampaign(c).catch((e) => {
        logger.error('supervisor', `tick(${c.id}) crashed: ${e && e.message ? e.message : e}`, c.id);
        db.setCampaignStatus(c.id, 'error', String(e && e.message || e));
      }).finally(() => inflight.delete(c.id));
    }
  }, TICK_INTERVAL_MS);
  logger.info('supervisor', `started, tick=${TICK_INTERVAL_MS}ms`);
}
