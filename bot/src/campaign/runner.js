// Per-tick campaign logic. Called from the supervisor every 5s for each
// running campaign. At most one X.com action per tick.
//
// Decision tree:
//   1. sleep window? → bail
//   2. hourly cap reached? → bail
//   3. cooldown since last action not elapsed? → bail
//   4. queue empty + searchEverySec elapsed? → search, refill queue
//   5. queue has items? → reply to next tweet, dedup-mark
import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { decryptJSON } from '../core/crypto.js';
import { XClient } from '../x/client.js';
import { capturedOps } from '../x/captured-ops.js';
import { rewriteTemplate } from '../persona/persona.js';

const PASSPHRASE = process.env.ENCRYPTION_PASSPHRASE;

// Light in-memory queue cache; rebuilt on each search. Keyed by campaign id.
const queues = new Map();
const lastTickedAt = new Map();

export async function tickCampaign(campaign) {
  const cfg = JSON.parse(campaign.config_json);
  const acct = db.getAccount(campaign.account_id);
  if (!acct) { db.setCampaignStatus(campaign.id, 'error', 'account missing'); return; }

  // Sleep window?
  const sleepRemain = inSleepWindow(cfg.sleep);
  if (sleepRemain != null) {
    const last = lastTickedAt.get(campaign.id) || 0;
    if (Date.now() - last > 60_000) {
      logger.info('runner', `c${campaign.id} in sleep window, ${Math.ceil(sleepRemain/60)}min left`, campaign.id);
      lastTickedAt.set(campaign.id, Date.now());
    }
    return;
  }

  // Hourly cap (token bucket)?
  const sentLastHour = db.countSentLastHour(campaign.id);
  if (sentLastHour >= (cfg.pacing.maxRepliesPerHour || 15)) {
    return; // Will be re-checked next tick.
  }

  // Cooldown since last action?
  const sinceAction = Date.now() - (campaign.last_action_at || 0);
  const cooldownMs = jitterMs(cfg.pacing.minDelaySec, cfg.pacing.maxDelaySec);
  if (campaign.last_action_at && sinceAction < cooldownMs) return;

  let client;
  try {
    const secrets = decryptJSON(PASSPHRASE, acct.secrets_blob);
    client = new XClient({ secrets, proxy: acct.proxy || null, lang: cfg.lang || 'en' });
  } catch (e) {
    db.setCampaignStatus(campaign.id, 'error', `decrypt failed: ${e.message}`);
    logger.error('runner', `c${campaign.id} decrypt: ${e.message}`, campaign.id);
    return;
  }

  // Search if queue empty.
  let queue = queues.get(campaign.id) || [];
  if (queue.length === 0) {
    const sinceSearch = Date.now() - (campaign.last_search_at || 0);
    if (campaign.last_search_at && sinceSearch < (cfg.pacing.searchEverySec || 180) * 1000) return;
    try {
      queue = await runSearchPhase(client, campaign, cfg);
      queues.set(campaign.id, queue);
      db.bumpCampaignAction(campaign.id, 'search');
      logger.info('runner', `c${campaign.id} search → ${queue.length} usable`, campaign.id);
    } catch (e) {
      logger.error('runner', `c${campaign.id} search: ${e.message}`, campaign.id);
      if (e.status === 401 || e.status === 403 || e.status === 429) {
        db.setCampaignStatus(campaign.id, 'error', e.message);
      }
      return;
    }
    if (queue.length === 0) return;
  }

  // Pop one and reply.
  const t = queue.shift();
  queues.set(campaign.id, queue);
  if (db.isSent(campaign.id, t.id)) return;

  const tpl = pickTemplate(cfg.templates);
  let text;
  try {
    text = await rewriteTemplate({
      template: tpl,
      tweet: t,
      persona: cfg.persona,
    });
  } catch (e) {
    text = renderTemplate(tpl, { author: t.authorHandle, name: t.authorName });
    logger.warn('runner', `c${campaign.id} AI rewrite failed, using raw template: ${e.message}`, campaign.id);
  }

  try {
    await client.createTweet({
      capturedOp: capturedOps.CreateTweet,
      text,
      replyToTweetId: t.id,
    });
    db.markSent(campaign.id, t.id);
    db.bumpCampaignAction(campaign.id, 'reply');
    logger.info('runner', `c${campaign.id} replied to @${t.authorHandle} (${t.id})`, campaign.id);
  } catch (e) {
    logger.error('runner', `c${campaign.id} reply ${t.id}: ${e.message}`, campaign.id);
    db.markSent(campaign.id, t.id); // don't retry the same broken tweet
    if (e.status === 401 || e.status === 403 || e.status === 429) {
      db.setCampaignStatus(campaign.id, 'error', e.message);
    }
  }
}

async function runSearchPhase(client, campaign, cfg) {
  if (!capturedOps.SearchTimeline) {
    throw new Error('SearchTimeline shape not captured. See bot/src/x/captured-ops.js');
  }
  const all = [];
  const seen = new Set();
  for (const kw of cfg.keywords) {
    try {
      const { tweets } = await client.searchTimeline({
        capturedOp: capturedOps.SearchTimeline,
        query: kw,
      });
      for (const t of tweets) {
        if (!seen.has(t.id)) { seen.add(t.id); all.push({ ...t, _kw: kw }); }
      }
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 429) throw e;
      logger.warn('runner', `c${campaign.id} search "${kw}": ${e.message}`, campaign.id);
    }
    await sleep(800 + Math.random() * 800);
  }
  // Filter
  return all.filter((t) => passesFilters(t, cfg.filters)).filter((t) => !db.isSent(campaign.id, t.id));
}

function passesFilters(t, f) {
  if (!t || !t.id || !t.text) return false;
  if (f.skipReplies && t.isReply) return false;
  if (f.skipRetweets && t.isRetweet) return false;
  if (f.skipQuotes && t.isQuote) return false;
  if (f.skipWithUrls && t.hasUrls) return false;
  if (f.minLikes && (t.favoriteCount || 0) < f.minLikes) return false;
  if (f.minAuthorFollowers && (t.authorFollowers || 0) < f.minAuthorFollowers) return false;
  if (f.langs?.length && t.lang && !f.langs.includes(t.lang)) return false;
  if (t.createdAt) {
    const ageSec = (Date.now() - new Date(t.createdAt).getTime()) / 1000;
    if (f.minTweetAgeSec && ageSec < f.minTweetAgeSec) return false;
    if (f.maxAgeMinutes && ageSec > f.maxAgeMinutes * 60) return false;
  }
  const handle = (t.authorHandle || '').toLowerCase();
  for (const h of (f.blacklistHandles || [])) {
    if (h && handle === String(h).toLowerCase().replace(/^@/, '')) return false;
  }
  const lower = (t.text || '').toLowerCase();
  for (const w of (f.blacklistWords || [])) {
    if (w && lower.includes(String(w).toLowerCase())) return false;
  }
  return true;
}

function pickTemplate(templates) {
  return templates[Math.floor(Math.random() * templates.length)];
}
function renderTemplate(tpl, ctx) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (ctx[k] != null ? String(ctx[k]) : ''));
}

// Log-normal jitter: most pauses short, occasional long ones (human-shaped).
function jitterMs(minSec, maxSec) {
  const lo = Math.max(1, minSec | 0);
  const hi = Math.max(lo + 1, maxSec | 0);
  let u1 = Math.random(); if (u1 < 1e-9) u1 = 1e-9;
  const u2 = Math.random();
  const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const mu = Math.log((lo + hi) / 2);
  let v = Math.exp(mu + 0.45 * n);
  if (v < lo) v = lo;
  if (v > hi * 1.5) v = hi;
  return v * 1000;
}

function inSleepWindow(s) {
  if (!s?.enabled) return null;
  const d = new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = parseHHMM(s.startHHMM);
  const end = parseHHMM(s.endHHMM);
  if (start == null || end == null) return null;
  let inside = start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
  if (!inside) return null;
  let mins = start <= end ? end - cur : (cur >= start ? (24 * 60 - cur) + end : end - cur);
  return mins * 60;
}
function parseHHMM(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
