# X Reply Bot

Two parts:

- **`/bot`** — the production bot. Standalone Node.js. No browser. Controlled from
  Telegram. **Use this for actual work.** See [`bot/README.md`](bot/README.md).
- **`/manifest.json` + `/src`** — Chrome extension. Used for **one-time capture**
  of X.com's rotating `queryId`s and feature flags. Paste them into
  `bot/data/captured-ops.json` and you're done; the bot hot-reloads.

## Workflow

1. **One-time:** load the Chrome extension, do one search + one tweet on x.com,
   copy captured shapes from the extension's Status → Diagnostics tab.
2. **Permanent:** run the bot from any machine (laptop, VPS) with a Telegram
   bot token. Control everything from your phone via Telegram.

## Why this split

X's web frontend rotates GraphQL `queryId` and `features` blob on every
release. Hardcoding them dies in weeks. Two options to keep up:

- **Capture from a real browser session** (this repo's choice). The extension
  observes live x.com traffic, the bot replays the captured shape.
- Reverse-engineer a blob-decoder for X's frontend bundles. Brittle, hard to
  maintain.

The bot itself does NOT need a browser. It uses `node-tls-client` to produce
Chrome's TLS Client Hello fingerprint at the network layer, so X.com's WAF
sees a real Chrome client, not a Node script.

## Components

```
manifest.json + src/         # Chrome MV3 extension (capture tool)
bot/                         # standalone bot (production)
  src/
    index.js                 # entry — boots Telegram + supervisor
    core/                    # db, crypto, logger, supervisor
    x/                       # XClient (HTTP w/ TLS impersonation)
    campaign/                # tick logic, defaults
    persona/                 # AI-rewriting templates with persona
    telegram/                # Telegram command handlers
  data/                      # state.db, captured-ops.json (gitignored)
  .env.example
```

## Anti-detection layers (per the prior project's design)

Implemented:
- Chrome TLS fingerprint (JA3) via `node-tls-client`
- HTTP/2 SETTINGS frame matching Chrome
- Header order matching Chrome
- Sec-Fetch-* and Client Hints
- CSRF (`ct0`) refreshed from cookie on every request
- Log-normal delay distribution between actions
- Token-bucket hourly cap (`maxRepliesPerHour`)
- Sleep window (HH:MM..HH:MM, supports midnight crossing)
- Diversity cooldown (don't repeat a template too soon)
- Min tweet age filter (don't reply within seconds of post)
- Persistent dedup (one tweet = one reply, ever)
- Hard stop on 401/403/429

Not implemented (deliberately, single-process scope):
- Per-account browser profile rotation (you don't have multiple accounts yet)
- Proxy pool with health checks (one proxy per account is enough for now;
  hooks are in place — set `accounts.proxy` directly in SQLite to use one)
- Vision (image understanding) — adds cost without strong ROI for crypto reply use case

See [`bot/README.md`](bot/README.md) for setup.
