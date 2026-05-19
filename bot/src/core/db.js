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
      -- hours" so the bot doesn't dogpile a single user's tweets.
      -- We store handles lower-cased; X handles are case-insensitive.
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
  // Handle is normalized to lowercase before storage / lookup. Returns the
  // ts of the last reply we sent to this author in this campaign, or 0 if
  // we've never replied to them.
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
};
