// Auto-prune module.
//
// Disables templates that have been used 20+ times with zero total
// engagement. These are "dead" templates — either the text doesn't
// resonate, targets the wrong audience, or is being filtered/shadowbanned.
//
// The prune check runs every 30 minutes across all active campaigns.
// When a template is pruned, it's marked disabled in template_stats and
// removed from the campaign's config_json. A log entry + notification
// is emitted so the user knows why throughput might dip.
import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { hashTemplate } from './template-hash.js';

const PRUNE_INTERVAL_MS = 30 * 60_000; // 30 min
const MIN_USES_BEFORE_PRUNE = 20;

let _interval = null;

/**
 * Start the auto-prune checker.
 */
export function startAutoPrune() {
  if (_interval) return;
  _interval = setInterval(pruneAllCampaigns, PRUNE_INTERVAL_MS);
  // First check after 5 minutes
  setTimeout(pruneAllCampaigns, 5 * 60_000);
  logger.info('auto-prune', `auto-prune started (interval=30min, threshold=${MIN_USES_BEFORE_PRUNE} uses)`);
}

function pruneAllCampaigns() {
  const campaigns = db.campaignsActive();
  for (const c of campaigns) {
    try {
      pruneCampaign(c);
    } catch (e) {
      logger.error('auto-prune', `c${c.id} prune check failed: ${e.message}`, c.id);
    }
  }
}

function pruneCampaign(campaign) {
  const stale = db.getStaleTemplates(campaign.id, MIN_USES_BEFORE_PRUNE);
  if (!stale.length) return;

  let cfg;
  try { cfg = JSON.parse(campaign.config_json); } catch { return; }
  if (!Array.isArray(cfg.templates) || cfg.templates.length === 0) return;

  let pruned = 0;
  const prunedTexts = [];

  for (const stat of stale) {
    // Find and remove the template from config
    const idx = cfg.templates.findIndex((t) => {
      const h = hashTemplate(t);
      return h === stat.template_hash;
    });

    if (idx !== -1) {
      const removed = cfg.templates.splice(idx, 1)[0];
      const text = typeof removed === 'string' ? removed : removed?.text || '?';
      prunedTexts.push(text.slice(0, 50));
      pruned++;
    }

    // Mark as disabled in stats table
    db.disableTemplate(campaign.id, stat.template_hash);
  }

  if (pruned > 0) {
    // Save updated config
    db.setCampaignConfig(campaign.id, JSON.stringify(cfg));

    const summary = prunedTexts.map((t) => `"${t}..."`).join(', ');
    logger.warn(
      'auto-prune',
      `c${campaign.id} pruned ${pruned} dead template(s) (${MIN_USES_BEFORE_PRUNE}+ uses, 0 engagement): ${summary}`,
      campaign.id,
    );
  }
}

/**
 * Check if a template is disabled (for use in runner's template picker).
 * Returns true if the template should be skipped.
 */
export function isTemplateDisabled(campaign_id, template) {
  const h = hashTemplate(template);
  if (!h) return false;
  const stats = db.getTemplateStats(campaign_id);
  const stat = stats.find((s) => s.template_hash === h);
  return stat?.disabled === 1;
}
