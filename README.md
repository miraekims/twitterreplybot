# X Reply Bot

Two cooperating components:

- **`/manifest.json` + `/src`** — Chrome MV3 extension. Watches live x.com
  traffic, owns cookies, exposes RPC handlers (`x.searchTimeline`,
  `x.createTweet`) over a local WebSocket to the bot.
- **`/bot`** — Node.js + SQLite + Telegram UI. Schedules campaigns,
  rate-limits, rewrites with OpenAI, sends RPC over the bridge.

The bot does NOT talk to x.com directly. The extension does. They
synchronise over `ws://host.docker.internal:8787` (Docker Desktop on
Mac/Win).

## Setup

```
cd bot
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS, XBOT_BRIDGE_TOKEN
docker compose up -d --build
```

Then in Chrome:

1. `chrome://extensions` → Load unpacked → pick this repo root.
2. Extension's Options page → paste bridge URL `ws://host.docker.internal:8787`
   + the same token you set in `bot/.env`.
3. Log in to x.com in any tab.
4. In Telegram: `/connect`. The bot replies `✓ Extension connected`.

See `bot/README.md` for command reference and architecture notes.

## Layout

```
.
├── manifest.json              # extension manifest
├── src/                       # extension code
│   ├── background/
│   │   ├── index.js           # service worker entry; routes RPCs
│   │   ├── bridge-client.js   # WebSocket client to the bot
│   │   ├── keepalive.js       # alarms watchdog + 6h x.com touch
│   │   ├── query-registry.js  # captures queryIds + headers from page traffic
│   │   └── x-api.js           # actual fetch → x.com (page MAIN world)
│   ├── content/               # page-hook + modal UI
│   ├── core/                  # storage helpers + the in-extension auto-runner
│   └── options/               # bridge URL & token settings page
└── bot/                       # Docker bot, see bot/README.md
```
