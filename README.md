# X Reply Bot (MV3)

Browser-extension-based modal for automating replies on X.com.

> **Status:** v0.1 skeleton — Comments tab is wired end-to-end, the rest is stubbed.
> Telegram bridge, AI replies, rules engine and rate-limit queue are next.

## How it works (short version)

1. A page-world hook (`src/content/page-hook.js`) silently observes every X.com
   GraphQL request and forwards `(operationName, queryId, headers, variables, features, body)`
   to the service worker.
2. The service worker stores the **latest** request shape per operation in
   `chrome.storage.local`. This means we never hardcode `queryId` / GraphQL
   `features` — they self-heal whenever X ships a frontend release.
3. When you trigger a feature in the modal, the SW replays the last seen
   request for that operation, swapping only the fields we need to change
   (e.g. `focalTweetId`, `tweet_text`, `reply.in_reply_to_tweet_id`).
4. CSRF (`x-csrf-token`) is always re-read from the `ct0` cookie at send time
   so it can never go stale.

## Loading the extension

### Chrome / Brave / Edge

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and pick this repo's root folder.
4. Open `https://x.com`. You should see a blue floating bot button in the
   bottom-right corner.

### Firefox

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json`.
3. Open `https://x.com`.

## Warm-up

The first time you install, the modal will say
**"Warming up — browse X to capture endpoints"**.

Trigger each operation **once** while logged in:

- `TweetDetail` — open any tweet permalink (`x.com/<user>/status/<id>`).
- `CreateTweet` — post or reply to anything once.

After that, the floating button shows `OK` and the Comments tab works.

## Project layout

```
manifest.json
src/
  background/
    index.js          # service worker / message router
    x-api.js          # GraphQL client (TweetDetail, CreateTweet)
    query-registry.js # stores latest seen request shape per op
  content/
    page-hook.js      # MAIN-world fetch/XHR observer
    index.js          # isolated-world entry, bridges to background
    modal.js          # modal UI logic
    modal.css         # scoped styles
    icons.js          # inline SVG icons
  core/
    storage.js        # chrome.storage.local wrapper
    crypto.js         # AES-GCM helpers (for upcoming telegram/AI secrets)
```

## Roadmap

- [ ] Search/Feed automation (keywords, filters, batch reply)
- [ ] Reply by @username (walk a list of profiles)
- [ ] Rate-limit queue with jitter + per-hour caps
- [ ] Reply templates with variables (`{author}`, `{quote}`)
- [ ] Optional AI rewriting (OpenAI / Anthropic) using passphrase-encrypted key
- [ ] Telegram bot bridge (long-poll from the SW; control from your phone)
- [ ] Like / Follow actions
- [ ] Logs viewer + CSV export
