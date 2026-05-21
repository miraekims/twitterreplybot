// Telegram Mini App HTTP server.
// Serves the frontend (static HTML) and REST API for campaign management.
// Designed to run alongside the bot on a configurable port (default 8788).
//
// The Mini App replaces numeric campaign IDs with the connected X @handle,
// and provides a step-by-step wizard UX so users never have to memorize
// slash commands.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../core/db.js';
import { bridge } from '../bridge/server.js';
import { logger } from '../core/logger.js';
import { defaultCampaignConfig, presetPacing, expectedDailyReplies, PRESETS } from '../campaign/defaults.js';
import { PERSONA_PRESETS } from '../persona/presets.js';
import { clearSoftBan } from '../campaign/runner.js';
import { bestHoursSummary } from '../campaign/best-hours.js';
import { getHourWeight, isGoldenHour } from '../campaign/activity-shift.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_PATH = path.resolve(__dirname, 'frontend');

let server;

export function startWebApp({ port = 8788 } = {}) {
  server = http.createServer(handleRequest);
  server.listen(port, '0.0.0.0', () => {
    logger.info('webapp', `Mini App server listening on :${port}`);
  });
  return server;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS for Telegram Mini App
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // API routes
  if (pathname.startsWith('/api/')) {
    return handleApi(req, res, pathname, url);
  }

  // Static frontend
  serveStatic(res, pathname);
}

function serveStatic(res, pathname) {
  if (pathname === '/' || pathname === '/index.html') pathname = '/index.html';
  const filePath = path.join(FRONTEND_PATH, pathname);
  // Security: prevent path traversal
  if (!filePath.startsWith(FRONTEND_PATH)) { res.writeHead(403); res.end(); return; }
  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// ---------- API ----------

async function handleApi(req, res, pathname, url) {
  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  try {
    // GET /api/status — bridge + account info
    if (pathname === '/api/status' && req.method === 'GET') {
      const bs = bridge.status();
      return json({
        bridge: bs.connected,
        handle: bs.handle || null,
        extVersion: bs.extVersion || null,
        lastPongAt: bs.lastPongAt || null,
      });
    }

    // GET /api/campaigns — list all campaigns (keyed by @handle, not numeric id)
    if (pathname === '/api/campaigns' && req.method === 'GET') {
      const all = db.listAllCampaigns();
      const campaigns = all.map((c) => {
        let cfg = {};
        try { cfg = JSON.parse(c.config_json); } catch {}
        // Resolve account handle
        const account = db.getAccount(c.account_id);
        return {
          id: c.id,
          handle: account?.handle || `account_${c.account_id}`,
          name: c.name,
          status: c.status,
          sentTotal: c.sent_total,
          sentLastHour: db.countSentLastHour(c.id),
          lastActionAt: c.last_action_at,
          lastError: c.last_error,
          dailyEstimate: expectedDailyReplies(cfg),
          config: cfg,
        };
      });
      return json({ campaigns });
    }

    // GET /api/campaign/:id — single campaign detail
    const campaignMatch = pathname.match(/^\/api\/campaign\/(\d+)$/);
    if (campaignMatch && req.method === 'GET') {
      const c = db.getCampaign(+campaignMatch[1]);
      if (!c) return json({ error: 'Not found' }, 404);
      let cfg = {};
      try { cfg = JSON.parse(c.config_json); } catch {}
      const account = db.getAccount(c.account_id);
      return json({
        id: c.id,
        handle: account?.handle || `account_${c.account_id}`,
        name: c.name,
        status: c.status,
        sentTotal: c.sent_total,
        sentLastHour: db.countSentLastHour(c.id),
        lastActionAt: c.last_action_at,
        lastError: c.last_error,
        dailyEstimate: expectedDailyReplies(cfg),
        config: cfg,
      });
    }

    // POST /api/campaign — create new campaign (wizard flow)
    if (pathname === '/api/campaign' && req.method === 'POST') {
      const body = await readBody(req);
      const { name, keywords, templates, persona, preset } = body;
      // Find account by connected handle
      const bs = bridge.status();
      if (!bs.connected || !bs.handle) {
        return json({ error: 'Chrome extension not connected. Open x.com first.' }, 400);
      }
      // Find or create account row for this handle
      const accounts = db.listAllCampaigns(); // we need listAccounts but need owner_tg
      // Use a fallback: find any account with this handle
      const allAccounts = getAllAccounts();
      let account = allAccounts.find((a) => a.handle === bs.handle);
      if (!account) {
        return json({ error: `No account registered for @${bs.handle}. Use /connect in Telegram first.` }, 400);
      }

      const cfg = defaultCampaignConfig(preset || 'safe');
      if (keywords?.length) cfg.keywords = keywords;
      if (templates?.length) cfg.templates = parseTemplatesFromApi(templates);
      if (persona) cfg.persona = persona;

      const id = db.insertCampaign({
        account_id: account.id,
        name: name || `Campaign ${bs.handle}`,
        config_json: JSON.stringify(cfg),
      });
      return json({ id, name: name || `Campaign ${bs.handle}`, status: 'idle' }, 201);
    }

    // PUT /api/campaign/:id/config — update campaign config
    const configMatch = pathname.match(/^\/api\/campaign\/(\d+)\/config$/);
    if (configMatch && req.method === 'PUT') {
      const c = db.getCampaign(+configMatch[1]);
      if (!c) return json({ error: 'Not found' }, 404);
      const body = await readBody(req);
      let cfg = {};
      try { cfg = JSON.parse(c.config_json); } catch {}
      // Merge provided fields. Preset FIRST so user overrides (like
      // qualityThreshold, commenterRatio) survive on top of the preset base.
      if (body.keywords !== undefined) cfg.keywords = body.keywords;
      if (body.templates !== undefined) cfg.templates = parseTemplatesFromApi(body.templates);
      if (body.persona !== undefined) cfg.persona = body.persona;
      if (body.preset) cfg.pacing = { ...cfg.pacing, ...presetPacing(body.preset) };
      if (body.pacing !== undefined) cfg.pacing = { ...cfg.pacing, ...body.pacing };
      if (body.filters !== undefined) cfg.filters = { ...cfg.filters, ...body.filters };
      if (body.sleep !== undefined) cfg.sleep = { ...cfg.sleep, ...body.sleep };
      db.setCampaignConfig(c.id, JSON.stringify(cfg));
      return json({ ok: true, config: cfg });
    }

    // POST /api/campaign/:id/run
    const runMatch = pathname.match(/^\/api\/campaign\/(\d+)\/run$/);
    if (runMatch && req.method === 'POST') {
      const id = +runMatch[1];
      clearSoftBan(id);
      db.setCampaignStatus(id, 'running');
      return json({ ok: true, status: 'running' });
    }

    // POST /api/campaign/:id/pause
    const pauseMatch = pathname.match(/^\/api\/campaign\/(\d+)\/pause$/);
    if (pauseMatch && req.method === 'POST') {
      db.setCampaignStatus(+pauseMatch[1], 'paused');
      return json({ ok: true, status: 'paused' });
    }

    // POST /api/campaign/:id/stop
    const stopMatch = pathname.match(/^\/api\/campaign\/(\d+)\/stop$/);
    if (stopMatch && req.method === 'POST') {
      db.setCampaignStatus(+stopMatch[1], 'idle');
      return json({ ok: true, status: 'idle' });
    }

    // GET /api/campaign/:id/logs
    const logsMatch = pathname.match(/^\/api\/campaign\/(\d+)\/logs$/);
    if (logsMatch && req.method === 'GET') {
      const rows = db.recentLogs(+logsMatch[1], 50);
      return json({ logs: rows.reverse() });
    }

    // GET /api/presets — list pacing presets
    if (pathname === '/api/presets' && req.method === 'GET') {
      return json({ presets: PRESETS });
    }

    // GET /api/personas — list persona presets
    if (pathname === '/api/personas' && req.method === 'GET') {
      return json({ personas: PERSONA_PRESETS });
    }

    // GET /api/settings — AI settings
    if (pathname === '/api/settings' && req.method === 'GET') {
      const settings = db.listSettings();
      const masked = settings.map((s) => ({
        key: s.key,
        value: s.key.includes('KEY') ? maskKey(s.value) : s.value,
        hasValue: !!s.value,
      }));
      return json({ settings: masked });
    }

    // PUT /api/settings — update AI settings
    if (pathname === '/api/settings' && req.method === 'PUT') {
      const body = await readBody(req);
      for (const [key, value] of Object.entries(body)) {
        if (['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL'].includes(key)) {
          if (value) {
            db.setSetting(key, value);
            process.env[key] = value;
          } else {
            db.deleteSetting(key);
            delete process.env[key];
          }
        }
      }
      return json({ ok: true });
    }

    // GET /api/campaign/:id/growth — engagement growth analytics
    const growthMatch = pathname.match(/^\/api\/campaign\/(\d+)\/growth$/);
    if (growthMatch && req.method === 'GET') {
      const id = +growthMatch[1];
      const c = db.getCampaign(id);
      if (!c) return json({ error: 'Not found' }, 404);

      const days = parseInt(url.searchParams.get('days') || '30', 10);
      const stats = db.getGrowthStats(id, days);
      const daily = db.getDailyGrowth(id, days);
      const hours = bestHoursSummary(id);
      const templateStats = db.getTemplateStats(id);

      return json({
        campaign_id: id,
        period_days: days,
        summary: {
          total_replies: stats?.total_replies || 0,
          total_likes: stats?.total_likes || 0,
          total_retweets: stats?.total_retweets || 0,
          total_follows: stats?.total_follows || 0,
          avg_engagement_score: Math.round((stats?.avg_score || 0) * 100) / 100,
          avg_quality_score: Math.round((stats?.avg_quality || 0) * 10) / 10,
        },
        daily,
        best_hours: hours,
        current_hour: {
          utc: new Date().getUTCHours(),
          weight: getHourWeight(id),
          is_golden: isGoldenHour(id),
        },
        templates: templateStats.map((t) => ({
          hash: t.template_hash,
          uses: t.uses,
          total_engagement: Math.round(t.total_engagement * 100) / 100,
          avg_engagement: t.uses > 0 ? Math.round((t.total_engagement / t.uses) * 100) / 100 : 0,
          disabled: !!t.disabled,
        })),
      });
    }

    // GET /api/campaign/:id/queue — reply queue with engagement data
    const queueMatch = pathname.match(/^\/api\/campaign\/(\d+)\/queue$/);
    if (queueMatch && req.method === 'GET') {
      const id = +queueMatch[1];
      const c = db.getCampaign(id);
      if (!c) return json({ error: 'Not found' }, 404);

      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const replies = db.getReplyQueue(id, limit);

      return json({
        campaign_id: id,
        count: replies.length,
        replies: replies.map((r) => ({
          reply_id: r.reply_id,
          tweet_id: r.tweet_id,
          template_hash: r.template_hash,
          ai_quality_score: r.ai_quality_score,
          likes: r.likes,
          retweets: r.retweets,
          replies: r.replies,
          follow_back: !!r.follow_back,
          score: Math.round((r.score || 0) * 100) / 100,
          sent_at: r.sent_at,
          checked_at: r.checked_at,
          hour_utc: r.hour_utc,
        })),
      });
    }

    return json({ error: 'Not found' }, 404);
  } catch (e) {
    logger.error('webapp', `API error: ${e.message}`);
    return json({ error: e.message }, 500);
  }
}

// ---------- Helpers ----------

function getAllAccounts() {
  return db.listAllAccounts();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseTemplatesFromApi(templates) {
  if (!Array.isArray(templates)) return [];
  return templates.map((t) => {
    if (typeof t === 'string') {
      const parts = t.split('|');
      if (parts.length >= 2) {
        const tags = parts[0].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        const text = parts.slice(1).join('|').trim();
        return { match: tags, text };
      }
      return { match: [], text: t.trim() };
    }
    if (t && typeof t === 'object') return t;
    return null;
  }).filter(Boolean);
}

function maskKey(val) {
  if (!val || val.length < 8) return '***';
  return val.slice(0, 4) + '...' + val.slice(-4);
}
