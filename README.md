# X Reply Bot (MV3)

Browser extension for X.com that auto-replies to posts matching your keywords,
using your reply templates, with anti-detection-grade pacing and filters.

## What it does

You provide:
- **keywords** — go straight into X search; supports operators
  (e.g. `solana min_faves:50 lang:en -filter:replies`)
- **reply templates** — picked randomly with a diversity cooldown so the same
  template isn't used twice in a row; supports `{author}` and `{name}`

The extension:
1. Searches X for matching tweets every N seconds.
2. Applies filters: min likes, min/max age, min author followers, lang,
   skip replies/retweets/quotes/links, blacklist words, blacklist handles.
3. Skips tweets it has already replied to (persistent dedup).
4. Picks a template (avoiding ones used in the last `diversityCooldownSec`).
5. Posts the reply, then waits a **log-normal** delay (humans don't have
   Gaussian pause distributions — many short pauses, occasional long ones).
6. Enforces an hourly token bucket: never exceeds `maxRepliesPerHour`.
7. Honors a sleep window (e.g. 01:00–08:00) so the account looks alive.
8. Hard-stops on `401`/`403`/`429` so you can't accidentally dig a hole.

## Self-healing X client

We never hardcode `queryId` or GraphQL `features`. A page-world hook observes
the live requests X.com makes and stores the latest shape per operation. When
you press Start, the service worker replays that shape, swapping only what we
need to change (search query, tweet text, reply target). When X ships a new
frontend, the next page load captures the new shape and we keep working.

## Install (Chrome / Brave / Edge)

```bash
git clone https://github.com/miraekims/twitterreplybot.git
cd twitterreplybot
git checkout feature/v0.1-skeleton
git pull origin feature/v0.1-skeleton
```

Then in Chrome:
1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick this folder
3. Open `https://x.com`. Bot button appears bottom-right.

If you've installed before, hit the **Reload** button on the extension card,
then refresh `x.com` (F5).

## Warm-up (once after install)

Trigger each operation once on x.com so the hook can capture it:
- **SearchTimeline** — type anything in X's search and press Enter.
- **CreateTweet** — post or reply to anything once.

Badge changes from `2` to `OK`. Now the **Auto-reply** tab can run.

## Recommended starter config

```
Keywords:
  gm
  gm degens
  solana lang:en min_faves:5 -filter:replies

Templates:
  gm fren
  GM!
  gm @{author}
  GM ☕

Filters:
  Min likes: 1
  Min tweet age (sec): 60
  Max age (min): 15
  Min followers: 100
  Langs: en
  Skip replies: ✓   Skip retweets: ✓   Skip quotes: ✓
  Skip posts with links: ✗

Pacing:
  Min delay (sec): 30
  Max delay (sec): 90
  Search every (sec): 240
  Max replies/hour: 10        ← start small for a fresh account
  Template diversity (sec): 1800
  Session cap: 5              ← first run

Sleep window:
  Enabled: ✗ (turn on later, e.g. 01:00–08:00 local)
```

The cap of 5 lets you verify everything works before scaling up.

## Anti-detection notes (what's actually under our control here)

This extension lives inside Chrome itself, not behind a proxy/Python stack.
That means several anti-bot signals are **already authentic** without any
work from us:

- TLS fingerprint (JA3/JA4) — identical to your real Chrome (we ARE that Chrome)
- `User-Agent`, Client Hints — identical to your real browser
- Cookie jar — your real session, including all auxiliary cookies
- Header order — Chrome's own order (we use `fetch`)

What we explicitly handle in code:
- `x-csrf-token` re-read from the live `ct0` cookie before every request
- captured `x-twitter-active-user`, `x-twitter-auth-type`, `x-twitter-client-language` replayed
- per-request stripping of stale pagination state (`cursor`, etc.)
- log-normal delays, token-bucket per-hour cap, sleep window, diversity cooldown
- min-tweet-age filter (don't reply within seconds of posting)
- blacklist words & handles

Things we do NOT do:
- replay `x-client-transaction-id` (it's a per-request anti-replay token —
  reusing it is a stronger signal than not sending it)

## Project layout

```
manifest.json
src/
  background/
    index.js          # SW message router
    x-api.js          # GraphQL client (TweetDetail, SearchTimeline, CreateTweet)
    query-registry.js # latest seen request shape per op
  content/
    page-hook.js      # MAIN-world fetch/XHR observer
    index.js          # bridge to background, boots UI
    modal.js          # tabs: auto / comments / status
    modal.css
    icons.js
  core/
    storage.js        # chrome.storage.local wrapper
    crypto.js         # AES-GCM (for upcoming TG/AI secrets)
    auto-runner.js    # MV3-safe alarm-driven loop
```

## Roadmap

- [ ] AI rewriting of templates (every reply unique even from one base)
- [ ] Telegram bot bridge (start/stop/logs from your phone)
- [ ] Persona / lore (RAG over examples) — biggest quality lever
- [ ] Likes & follows automation
- [ ] Per-keyword priorities and per-keyword templates
- [ ] CSV export of logs
