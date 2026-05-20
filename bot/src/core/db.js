// SQLite storage. Three tables:
//   accounts   — one row per connected X account; auth_token+ct0 are
//                encrypted with AES-GCM derived from ENCRYPTION_PASSPHRASE.
//   campaigns  — one row per campaign; references an account.
//   logs       — append-only ring of recent events (per campaign).
//
// We use better-sqlite3 (synchronous, fast, no native worker headaches).
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/state.db');

let _db;

export const db = {
  get path() { return DB_PATH; },

  async init() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');

    _db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_tg INTEGER NOT NULL,
        handle TEXT,
        secrets_blob TEXT NOT NULL,           -- AES-GCM(JSON{auth_token,ct0,bearer})
        created_at INTEGER NOT NULL,
        last_health_at INTEGER,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',  -- idle | running | paused | error
        config_json TEXT NOT NULL,            -- keywords, templates, filters, pacing, persona
        sent_total INTEGER NOT NULL DEFAULT 0,
        last_search_at INTEGER NOT NULL DEFAULT 0,
        last_action_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sent (
        campaign_id INTEGER NOT NULL,
        tweet_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (campaign_id, tweet_id)
      );

      -- Per-author cooldown — last time we replied to a given @handle in
      -- a given campaign. Used to throttle "one reply per author per N
      -- hours" so the bot doesn't dogpile a single user's tweets when
      -- several of theirs hit the home feed in quick succession.
      -- Handles are stored lower-cased; X handles are case-insensitive.
      CREATE TABLE IF NOT EXISTS author_replies (
        campaign_id INTEGER NOT NULL,
        author_handle TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (campaign_id, author_handle)
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        msg TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_logs_campaign ON logs(campaign_id, ts);

      -- Top-level posts (NOT replies). Created by /post (immediate),
      -- /draft (AI-suggested, awaiting user pick), or via the
      -- (planned) trend-extractor. Status transitions:
      --   draft     → user hasn't approved yet, ephemeral, may be deleted
      --   scheduled → approved, queued for the runner to publish
      --   published → posted_tweet_id is the live X tweet id
      --   failed    → publish attempt failed; error column has details
      --   cancelled → user dropped it pre-publish via /queue cancel
      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        link TEXT,
        topic TEXT,                          -- the seed used for /draft, NULL for /post
        status TEXT NOT NULL,                -- draft | scheduled | published | failed | cancelled
        scheduled_at INTEGER,                -- ms; null for draft/published
        posted_at INTEGER,                   -- ms; non-null when status=published
        posted_tweet_id TEXT,                -- live X tweet id once published
        error TEXT,                          -- last failure message, if any
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_posts_campaign_status ON posts(campaign_id, status);
      CREATE INDEX IF NOT EXISTS idx_posts_due ON posts(status, scheduled_at);

      -- Runtime app settings — small key/value store for things the user
      -- changes via Telegram (rather than restarting the container with
      -- a new .env). Today: OPENAI_API_KEY / OPENAI_MODEL /
      -- OPENAI_BASE_URL set via /apikey command. Loaded on boot in
      -- index.js, applied to process.env so persona.js + draft.js see
      -- them at call time.
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  },

  // ---------- accounts ----------
  insertAccount({ owner_tg, handle, secrets_blob }) {
    return _db.prepare(`INSERT INTO accounts (owner_tg, handle, secrets_blob, created_at)
                        VALUES (?, ?, ?, ?)`).run(owner_tg, handle, secrets_blob, Date.now()).lastInsertRowid;
  },
  listAccounts(owner_tg) {
    return _db.prepare(`SELECT id, handle, last_health_at, last_error FROM accounts WHERE owner_tg = ?`).all(owner_tg);
  },
  getAccount(id) {
    return _db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id);
  },
  deleteAccount(id) { _db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id); },
  setAccountHealth(id, ts, err = null) {
    _db.prepare(`UPDATE accounts SET last_health_at = ?, last_error = ? WHERE id = ?`).run(ts, err, id);
  },

  // ---------- campaigns ----------
  insertCampaign({ account_id, name, config_json }) {
    return _db.prepare(`INSERT INTO campaigns (account_id, name, config_json, created_at)
                        VALUES (?, ?, ?, ?)`).run(account_id, name, config_json, Date.now()).lastInsertRowid;
  },
  listCampaigns(owner_tg) {
    return _db.prepare(`
      SELECT c.* FROM campaigns c JOIN accounts a ON a.id = c.account_id
      WHERE a.owner_tg = ?`).all(owner_tg);
  },
  getCampaign(id) { return _db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id); },
  listAllCampaigns() { return _db.prepare(`SELECT * FROM campaigns`).all(); },
  setCampaignStatus(id, status, err = null) {
    _db.prepare(`UPDATE campaigns SET status = ?, last_error = ? WHERE id = ?`).run(status, err, id);
  },
  setCampaignConfig(id, config_json) {
    _db.prepare(`UPDATE campaigns SET config_json = ? WHERE id = ?`).run(config_json, id);
  },
  bumpCampaignAction(id, kind) {
    if (kind === 'search') _db.prepare(`UPDATE campaigns SET last_search_at = ? WHERE id = ?`).run(Date.now(), id);
    if (kind === 'reply') _db.prepare(`UPDATE campaigns SET last_action_at = ?, sent_total = sent_total + 1 WHERE id = ?`).run(Date.now(), id);
  },
  campaignsActive() {
    return _db.prepare(`SELECT * FROM campaigns WHERE status = 'running'`).all();
  },

  // ---------- sent dedup ----------
  isSent(campaign_id, tweet_id) {
    return !!_db.prepare(`SELECT 1 FROM sent WHERE campaign_id = ? AND tweet_id = ?`).get(campaign_id, tweet_id);
  },
  markSent(campaign_id, tweet_id) {
    _db.prepare(`INSERT OR IGNORE INTO sent (campaign_id, tweet_id, ts) VALUES (?, ?, ?)`)
       .run(campaign_id, tweet_id, Date.now());
  },
  countSentLastHour(campaign_id) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return _db.prepare(`SELECT COUNT(*) AS n FROM sent WHERE campaign_id = ? AND ts >= ?`).get(campaign_id, cutoff).n;
  },

  // ---------- per-author cooldown ----------
  // Returns the ts of the last reply we sent to this author in this
  // campaign, or 0 if we've never replied to them. Handles are
  // normalized to lowercase before lookup/storage.
  lastAuthorReplyTs(campaign_id, handle) {
    if (!handle) return 0;
    const h = String(handle).toLowerCase();
    const row = _db.prepare(
      `SELECT ts FROM author_replies WHERE campaign_id = ? AND author_handle = ?`,
    ).get(campaign_id, h);
    return row ? row.ts : 0;
  },
  markAuthorReplied(campaign_id, handle) {
    if (!handle) return;
    const h = String(handle).toLowerCase();
    _db.prepare(
      `INSERT INTO author_replies (campaign_id, author_handle, ts)
         VALUES (?, ?, ?)
       ON CONFLICT(campaign_id, author_handle) DO UPDATE SET ts = excluded.ts`,
    ).run(campaign_id, h, Date.now());
  },

  // ---------- logs ----------
  log(campaign_id, level, msg) {
    _db.prepare(`INSERT INTO logs (campaign_id, ts, level, msg) VALUES (?, ?, ?, ?)`)
       .run(campaign_id, Date.now(), level, msg);
    // Keep last 500 per campaign.
    _db.prepare(`DELETE FROM logs WHERE campaign_id = ? AND id NOT IN (
                   SELECT id FROM logs WHERE campaign_id = ? ORDER BY id DESC LIMIT 500
                 )`).run(campaign_id, campaign_id);
  },
  recentLogs(campaign_id, limit = 30) {
    return _db.prepare(`SELECT ts, level, msg FROM logs WHERE campaign_id = ?
                        ORDER BY id DESC LIMIT ?`).all(campaign_id, limit);
  },

  // ---------- posts (top-level tweets) ----------
  //
  // These are author-initiated tweets, NOT replies. Two creation paths:
  //   /post <text>  → status='scheduled' at now (immediate publish on
  //                   next runner tick, ≤30s)
  //   /draft        → status='draft' for each candidate; user approves
  //                   one which flips it to 'scheduled' at a future
  //                   slot and cancels its sibling drafts.

  /**
   * Insert a draft (status='draft', no scheduled_at). Returns id.
   * Drafts have no scheduled_at — they're not visible to the runner
   * until the user approves and we re-stamp scheduled_at.
   */
  insertDraft({ campaign_id, text, topic = null, link = null }) {
    return _db.prepare(`
      INSERT INTO posts (campaign_id, text, link, topic, status, created_at)
      VALUES (?, ?, ?, ?, 'draft', ?)
    `).run(campaign_id, text, link, topic, Date.now()).lastInsertRowid;
  },

  /**
   * Insert a post directly into the scheduled queue. Used by /post
   * (when user types their own text and we publish on next tick).
   */
  insertScheduledPost({ campaign_id, text, link = null, topic = null, scheduled_at }) {
    return _db.prepare(`
      INSERT INTO posts (campaign_id, text, link, topic, status, scheduled_at, created_at)
      VALUES (?, ?, ?, ?, 'scheduled', ?, ?)
    `).run(campaign_id, text, link, topic, scheduled_at, Date.now()).lastInsertRowid;
  },

  getPost(id) {
    return _db.prepare(`SELECT * FROM posts WHERE id = ?`).get(id);
  },

  /**
   * Promote a draft to scheduled at a specific time. Idempotent on
   * already-scheduled rows (re-stamps scheduled_at).
   */
  schedulePost(id, scheduled_at) {
    _db.prepare(`UPDATE posts SET status = 'scheduled', scheduled_at = ?, error = NULL
                 WHERE id = ?`).run(scheduled_at, id);
  },

  cancelPost(id) {
    _db.prepare(`UPDATE posts SET status = 'cancelled' WHERE id = ?`).run(id);
  },

  markPostPublished(id, tweet_id) {
    _db.prepare(`UPDATE posts SET status = 'published', posted_at = ?,
                 posted_tweet_id = ?, error = NULL WHERE id = ?`)
       .run(Date.now(), tweet_id, id);
  },

  markPostFailed(id, error) {
    _db.prepare(`UPDATE posts SET status = 'failed', error = ? WHERE id = ?`)
       .run(error || '', id);
  },

  /**
   * Posts whose scheduled_at has elapsed and are still in 'scheduled'
   * status. The runner publishes these and updates status.
   */
  duePosts(now) {
    return _db.prepare(`SELECT * FROM posts
                        WHERE status = 'scheduled' AND scheduled_at <= ?
                        ORDER BY scheduled_at ASC LIMIT 5`).all(now);
  },

  /**
   * For daily-cap accounting (scheduler.js#nextSlotAt). Returns posts
   * created or scheduled in the last `since` ms for `campaign_id`,
   * EXCLUDING cancelled and failed (failures don't burn quota — user
   * should be allowed to retry).
   */
  recentPostsForCap(campaign_id, since) {
    return _db.prepare(`SELECT id, status, scheduled_at, posted_at FROM posts
                        WHERE campaign_id = ?
                          AND status IN ('scheduled', 'published')
                          AND COALESCE(scheduled_at, posted_at, created_at) >= ?
                        ORDER BY id DESC`).all(campaign_id, since);
  },

  /**
   * Currently-queued posts for the user-facing /queue command.
   * Includes drafts so users can clean up unapproved candidates.
   */
  listQueuedPosts(campaign_ids) {
    if (!campaign_ids?.length) return [];
    const placeholders = campaign_ids.map(() => '?').join(',');
    return _db.prepare(`SELECT * FROM posts
                        WHERE campaign_id IN (${placeholders})
                          AND status IN ('draft', 'scheduled')
                        ORDER BY COALESCE(scheduled_at, created_at) ASC
                        LIMIT 50`).all(...campaign_ids);
  },

  /**
   * Recent posts (any status) for a campaign, for /posts list view.
   */
  recentPosts(campaign_id, limit = 20) {
    return _db.prepare(`SELECT * FROM posts WHERE campaign_id = ?
                        ORDER BY id DESC LIMIT ?`).all(campaign_id, limit);
  },

  /**
   * Cleanup helper — drop drafts older than `maxAgeMs`. Drafts that
   * never got approved would otherwise accumulate. We don't expose
   * this to users; it's called periodically from the scheduler tick.
   * Excluded from /queue too once age elapses, even before deletion.
   */
  pruneOldDrafts(maxAgeMs = 24 * 3600 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    _db.prepare(`DELETE FROM posts WHERE status = 'draft' AND created_at < ?`).run(cutoff);
  },

  // ---------- app settings (runtime config from /apikey) ----------
  //
  // Tiny KV store for env-style settings that the user changes via
  // Telegram. Today: OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL.
  // index.js loads these on boot into process.env so persona.js and
  // draft.js (which call readConfig() on each generation request) see
  // them transparently.
  //
  // Why DB and not a config file: the bot runs in Docker, the user is
  // on Telegram. They shouldn't have to ssh into the container or
  // edit .env to change a key. Container restart is also unnecessary —
  // we update process.env in-place on /apikey set.
  getSetting(key) {
    const row = _db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key);
    return row ? row.value : null;
  },
  setSetting(key, value) {
    _db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value), Date.now());
  },
  deleteSetting(key) {
    _db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key);
  },
  /**
   * For debug — returns all settings with masked values. Used by
   * /apikey (no args) to show current state without leaking the key.
   */
  listSettings() {
    return _db.prepare(`SELECT key, value, updated_at FROM app_settings ORDER BY key`).all();
  },
};
