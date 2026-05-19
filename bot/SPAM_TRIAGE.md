# Spam-class triage — read first if your ER is dropping

If your X analytics show declining engagement rate, low replies/likes
on your replies, and you're worried about "probably spam" status:
the algorithm has likely flagged your reply velocity ÷ engagement
ratio as suspicious. This file is the emergency checklist.

## The five spam triggers (X auto-detector)

| Trigger | Healthy account | Account at risk |
|---|---|---|
| Reply-to-original ratio | <70% replies | >95% replies |
| Reply velocity vs account age | gradual rampup | sustained high from day 1 |
| Engagement on own replies | stable or growing ER | falling ER |
| Followers/replies ratio | >1 | <0.3 |
| Pinned post / landing | clear thesis pinned | nothing pinned |

If three or more of the right column describe you, X is throttling
your reply distribution (shadowban-lite). Engagement rate falls
because fewer people see your replies, not because your replies got
worse.

## Stop the bleeding (do TODAY, in order)

1. **Cut pacing in half.** If your campaign is on `highvolume`, switch
   to `safe` or `medium`. 15-25 high-quality replies a day beat 60+
   in shadowban.
   ```
   /preset <id> safe
   ```

2. **Drop catch-all templates.** Catch-all templates fire on tweets
   the bot has nothing specific to say about, which produces generic
   replies — the strongest spam signal. Re-paste your templates
   without any line that lacks the `|` separator.

3. **Tighten filters.** In your campaign config, raise:
   - `minLikes`: 5 → 10 (no replies under empty tweets)
   - `minAuthorFollowers`: → 1000 (no replies to brand-new accounts)
   - `skipReplies: true` (replies under replies rarely convert)
   - `langs: ['en']` (cuts random foreign-language matches)

4. **Post 3 original tweets manually today.** Any topic, any length.
   The reply-to-original ratio is the single biggest spam-class
   signal. Even meh tweets fix it.

5. **Pin a tweet that explains who you are in 1-2 lines + one
   concrete number** (a take, a result, a thesis). Without this,
   profile clicks bounce and don't convert to follows, which hurts
   the same metric chain.

## After the triage, what fixes the long term

Replies in isolation never grow accounts on X anymore. The viable
loop is:

```
quality replies → reader clicks profile → sees pinned + recent
posts → follows → over time engages → algorithm boosts your replies
in their feed → engagement rate stabilizes
```

Three of those four steps need ORIGINAL POSTS. That's why the
auto-post engine (planned PR4 in ROADMAP.md) is the actual fix to
low ER, not better templates.

Templates v2 with audience-aware hooks
(`bot/templates/peak-v2-hooks.md`) is the medium-term reply quality
fix. It rewrites every template to engage thread-readers, not just
the original author.

## How to know triage worked

Watch these metrics over 7-14 days after the changes:

- **Engagement rate**: should stop falling, then climb. Target 3%+
  for crypto reply accounts.
- **Profile visits per reply**: should rise from <1 to 2-5.
- **Replies received on your replies**: any number > 0 is good. Zero
  consistently = still in shadowban.
- **Followers/day**: 1-5/day in the first month is normal for a
  clean account.

If after 2 weeks of triage + original posts your ER is still falling,
the account may be flagged below recovery threshold — start fresh
with a new handle and apply these rules from day one.
