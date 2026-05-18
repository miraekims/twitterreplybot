# X Reply Bot

Standalone Node.js bot that drives X.com auto-replies. Telegram for
control, SQLite for state, OpenAI for persona-aware reply rewriting,
and **a Chrome extension over a local WebSocket bridge** for the actual
HTTP to x.com.

## Why a bridge instead of HTTP directly

Earlier versions of the bot used `curl-impersonate-chrome` plus a hand-
rolled `xclienttransaction` integration to mimic real Chrome traffic. That
worked until X started rotating `queryId`, `x-client-transaction-id` and
the ondemand bundle shape on every frontend release. Maintaining all that
in a Node container was a constant losing battle.

The current architecture moves the actual HTTP back to a real Chrome
running locally — the extension already lives on x.com, sees fresh
cookies, fresh queryIds, fresh transaction-ids, and trivially passes the
WAF because it is literally Chrome. The bot keeps the persistent things
(scheduler, DB, Telegram UI, OpenAI rewriting) and the extension is a
remote-controlled hand. They talk over `ws://host.docker.internal:8787`.

## Setup

1. **Bot side**

   ```sh
   cp .env.example .env
   # fill in TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS, XBOT_BRIDGE_TOKEN,
   # OPENAI_API_KEY (optional)
   docker compose up -d --build
   ```

   The bridge listens on `127.0.0.1:8787` (LAN-private).

2. **Chrome side**

   - Load the extension from `../src` via `chrome://extensions` → Load
     unpacked.
   - Click the extension's "Details" → "Extension options" and paste:
     - URL: `ws://host.docker.internal:8787`
     - Token: same value as `XBOT_BRIDGE_TOKEN` in `bot/.env`
   - Open x.com in any tab and log in.

3. **Connect**

   ```
   /connect    in Telegram
   ```
   Bot will reply `✓ Extension connected: @yourhandle`.

4. **Create a campaign**

   ```
   /new        # walks you through name + keywords + templates + persona
   /run <id>   # start
   /preset <id> highvolume   # if you want to push toward 1000/day
   /stats <id> # check bridge status, last op refresh, hourly counter
   ```

## Layout

```
bot/
  src/
    bridge/server.js     # WebSocket server, RPC framing, status surface
    campaign/runner.js   # per-tick logic: search, filter, reply, dedup
    campaign/defaults.js # safe / medium / highvolume pacing presets
    core/db.js           # SQLite (campaigns, sent, logs)
    core/supervisor.js   # 5s tick driver
    core/logger.js       # stdout + per-campaign DB log ring
    persona/persona.js   # OpenAI rewrite or literal substitution
    telegram/bot.js      # commands + conversational forms
    x/client.js          # thin RPC wrapper around the bridge
    index.js             # entry point
  data/
    state.db             # gitignored
  Dockerfile
  docker-compose.yml
  .env.example
```

## Where things go wrong

- Bridge offline → `/stats` shows `Bridge: ✗`, campaigns idle silently.
  Open Chrome on x.com → bridge reconnects on its own → campaigns
  resume on next 5s tick.
- 401/403/429 from x.com → campaign hard-stops (don't spam into a wall).
  Usual cause: cookies expired in Chrome, or X rate-limited the account.
- Replies look samey → set `OPENAI_API_KEY`, optionally `OPENAI_MODEL=gpt-4o`.
