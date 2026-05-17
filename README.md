# X Reply Bot (MV3)

Browser-extension modal that auto-replies to X.com posts matching your keywords,
using your reply templates.

> **v0.2** — Auto-reply campaign is the main flow.
> Comments tab is kept (single-tweet replies) for later use.
> Telegram bridge, AI rewriting, likes/follows are next.

## What it does

You provide:
- a list of **keywords** (e.g. `gm`, `gm degens`, `#crypto`, `$BTC`)
- a list of **reply templates** (one per line, plain text or with `{author}` / `{name}`)

The extension:
1. Searches X for tweets matching ANY keyword (Latest tab) every N seconds.
2. Filters out: replies, retweets, posts older than X minutes, posts under your
   liked/followers thresholds, optionally posts containing links.
3. Skips tweets it has already replied to (persistent dedup).
4. Picks a random template, renders it, and posts a reply under the tweet.
5. Sleeps a jittered delay between actions.
6. Hard-stops on `401`/`403`/`429` so you can't spam yourself into a ban.

## Self-healing X client

We never hardcode `queryId` or GraphQL `features`. A page-world hook
(`src/content/page-hook.js`) observes the live requests X.com makes and stores
the latest shape per operation. When you press Start, the service worker replays
that exact shape, swapping only what we need to change (search query, tweet
text, reply target). When X ships a frontend update, the next time you load
x.com the new shape is captured and we keep working.

## Loading

### Chrome / Brave / Edge
1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → repo root.
2. Open `https://x.com`. Blue floating bot button appears bottom-right.

### Firefox
1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → `manifest.json`.

## Warm-up (do this once after install)

Badge says `2`. Two operations to capture:

1. **SearchTimeline** — type anything in X's search bar and press Enter.
2. **CreateTweet** — post or reply to anything once.

Badge changes to `OK`. Now the **Auto-reply** tab can run.

## Auto-reply tab

- **Keywords** — one per line. They go straight into X's search.
- **Templates** — one per line, picked randomly per reply. Supports
  `{author}` (handle) and `{name}` (display name).
- **Filters** — min likes, max age in minutes, min author followers,
  language list, skip replies/retweets/links.
- **Pacing** — min/max delay between replies (jittered), how often to re-search,
  session cap (auto-stop after N replies).
- **Save / Start / Stop / Reset history** — config persists across page reloads;
  history of replied tweets is kept in `chrome.storage.local`.

The floating button shows the count of replies sent in the current session.

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
    auto-runner.js    # search → filter → reply loop
```

## Roadmap

- [ ] AI rewriting (so each reply is unique even from the same template)
- [ ] Telegram bot bridge (control / start / stop / logs from your phone)
- [ ] Likes + follows automation
- [ ] Keyword groups with per-group templates
- [ ] CSV export of logs
- [ ] Smarter Comments tab (filter, batch reply, keyword match inside replies)
