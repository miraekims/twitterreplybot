# X Reply Bot — Standalone (Telegram-controlled)

Headless bot. No browser, no opened tab. Controlled from Telegram.
Each X account is one campaign; campaigns survive process restarts.

## Architecture

```
Telegram (your phone)  ←→  this Node process  ←→  X.com (via tls-client)
                              │
                              └→ SQLite (encrypted cookies + state)
```

- **One process** runs N campaigns. State persists in `data/state.db`.
- **Cookies & secrets are encrypted at rest** with AES-GCM (passphrase from `.env`).
- **TLS impersonation** (`node-tls-client`) makes our HTTP traffic look
  like real Chrome to X's WAF. If the package fails to install (Go
  binary download blocked), the bot falls back to native fetch and
  logs a warning — you'll know.
- **Captured GraphQL shapes** (`queryId`, `features`, `variables`) come
  from the browser extension at the repo root. Run the extension once,
  copy `bot/data/captured-ops.json.example` → `captured-ops.json`,
  paste from the extension's Diagnostics tab.

## Install

Requires Node.js 20+.

```bash
cd bot
cp .env.example .env
# edit .env: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS, ENCRYPTION_PASSPHRASE
npm install
npm start
```

If `node-tls-client` failed to install on `npm install`, that's OK —
it's marked optional. The bot will start, but X requests will probably
get 404'd until you fix it. Workarounds in the prior project's docs:
ensure your machine can download Go binaries from GitHub releases on
postinstall.

## First-time setup

### 1. Get a Telegram bot token

Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → get token.

### 2. Find your Telegram user id

Talk to [@userinfobot](https://t.me/userinfobot) → it returns your numeric id.

### 3. Fill `.env`

```
TELEGRAM_BOT_TOKEN=123456:AAA...
TELEGRAM_ALLOWED_USERS=123456789
ENCRYPTION_PASSPHRASE=anyLongPassphrase
OPENAI_API_KEY=sk-...   # optional, for AI persona-aware replies
```

### 4. Capture GraphQL shapes (one-time per X frontend version)

The X frontend rotates `queryId`s every release. To not chase that
manually, use the browser extension at the repo root:

1. Load the extension (see top-level README).
2. On x.com, do **one search** and **post one tweet** (warmup).
3. Open the extension modal → **Status** tab → **Diagnostics** card.
4. Copy `capturedOp` JSON for both `SearchTimeline` and `CreateTweet`.
5. Create `bot/data/captured-ops.json` based on the `.example` file:

```json
{
  "SearchTimeline": { ... paste the capturedOp here ... },
  "CreateTweet": { ... paste the capturedOp here ... }
}
```

The bot hot-reloads this file. No restart needed.

### 5. Talk to your bot

In Telegram, message your bot:

```
/start              — help
/connect            — paste auth_token + ct0 of your X account
/new <account_id>   — create a campaign (keywords + templates + persona)
/run <campaign_id>  — start
/stats <id>, /logs <id>, /pause, /stop
```

## Connecting an X account (cookies, not password)

`/connect` walks you through three prompts: handle, `auth_token`, `ct0`.

How to get them:
1. Open `x.com` while logged in.
2. F12 → Application → Cookies → `https://x.com`.
3. Copy values of `auth_token` and `ct0`.

Both are stored AES-GCM-encrypted with your passphrase. The plaintext
is only held in memory during a request. Logs always mask them.

## Campaign defaults (matching prior project's recommendations)

```
maxRepliesPerHour: 10           # ramp up after a week
minDelaySec: 25, maxDelaySec: 90  # log-normal jittered
searchEverySec: 180
maxAgeMinutes: 10               # don't reply to stale posts
minTweetAgeSec: 60              # don't reply within seconds of post
diversityCooldownSec: 1800      # don't repeat same template too soon
sleep window: 01:00-08:00 enabled
```

All defaults live in `src/campaign/defaults.js` and can be edited per
campaign by editing `config_json` in SQLite (or via future
`/edit <id>` command — not yet implemented).
