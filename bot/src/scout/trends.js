// Trend extractor — surfaces what's trending in the user's existing X
// home feed. Zero external API, zero additional scraping: every tweet
// the runner already pulls in runFeedScan() is also pushed through
// observe(), tokenised, and stored in the trend_observations ledger.
//
// Why a separate module and not "just a function in runner.js":
//   - tokenisation rules (stopwords, $TICKER preservation, hashtag
//     handling) belong with their consumer (the /trends command and
//     the spike detector), not buried inline in runner's I/O loop;
//   - the same observe() will eventually be called from the auto-post
//     engine (PR5: trend-driven drafts) and from any future
//     "rolling 7-day digest" feature;
//   - keeping the scoring logic isolated lets us tune thresholds
//     without re-reading the runner.
//
// Pipeline:
//
//   runner.runFeedScan(...)
//      → trends.observe(campaignId, tweets)
//          → extractTermsFromTweet(t) for each tweet
//          → db.insertTrendObservations(campaignId, rows)
//          → db.pruneOldTrendObservations(7d)  (every ~30min)
//
//   /trends → trends.topSpikes(campaignId)
//      → db.trendCountsSince(6h, minCount=3)
//      → db.trendCountsBetween(24h..6h ago, minCount=1)  (baseline)
//      → score = count6h / max(baseline_per_6h, 0.5)
//      → drop terms with score < SPIKE_RATIO
//      → return top N with their last sample tweet
//
// All thresholds are tunable via config but the defaults below were
// picked to make the typical crypto-CT feed produce 3-7 visible
// spikes per query without firehosing noise (manually validated on
// a snapshot of ~6h of HomeTimeline data).

import { db } from '../core/db.js';
import { logger } from '../core/logger.js';

// Defaults. Caller can override via topSpikes() args.
const DEFAULTS = {
  recentWindowMs: 6 * 3600 * 1000,    // "now" window
  baselineWindowMs: 18 * 3600 * 1000, // older 18h ⇒ 24h total
  minRecentCount: 3,                  // term must appear ≥ this in recent
  minSpikeRatio: 2.0,                 // recent rate / baseline rate
  topN: 5,
  pruneMaxAgeMs: 7 * 24 * 3600 * 1000,
};

// Pruning is expensive only on the first call after restart (large
// table) and ~free thereafter. We rate-limit it to once per ~30min so
// observe() stays cheap on the hot path.
const PRUNE_INTERVAL_MS = 30 * 60 * 1000;
let _lastPruneAt = 0;

// Stopwords. Kept short on purpose — only words that genuinely add
// no signal in CT context. We keep "gm", "wagmi", "lfg", emoji-words
// etc. because they ARE signal: a sudden gm-storm is a thing.
//
// Adding a stopword later is risk-free; removing one means we throw
// away historical observations that already filtered it out.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'you', 'your',
  'this', 'that', 'have', 'has', 'had', 'not', 'but', 'all', 'any',
  'they', 'them', 'their', 'there', 'these', 'those', 'will', 'would',
  'could', 'should', 'just', 'when', 'where', 'who', 'what', 'why',
  'how', 'from', 'about', 'into', 'over', 'than', 'then', 'them',
  'now', 'one', 'two', 'three', 'too', 'very', 'really', 'only',
  'also', 'some', 'most', 'much', 'many', 'more', 'less', 'few',
  'don', 'didn', 'doesn', 'isn', 'aren', 'wasn', 'weren', 'won',
  'can', 'cant', 'cannot', 'its', 'theyre', 'youre', 'were', 'been',
  // very common CT noise that adds no signal
  'crypto', 'bitcoin', 'btc', 'eth', 'sol', // YES we drop the majors;
  // they appear in 30% of all tweets so they always "trend" by raw
  // count. The real signal is the LONG TAIL: a niche project name
  // suddenly hitting 5+ mentions in 6h is interesting; "btc" hitting
  // 200 mentions in 6h is just Tuesday.
]);

// Maximum tokens we extract per tweet. A 280-char tweet rarely has
// >20 meaningful tokens; capping prevents a token-spam tweet (someone
// pastes a wallet's full transaction list) from skewing observations.
const MAX_TOKENS_PER_TWEET = 20;

/**
 * Tokenise a tweet into normalised "terms" suitable for trend
 * tracking. Returns a unique-within-tweet array (we don't want
 * "eth eth eth" to count as 3 observations of "eth" from one tweet).
 *
 * Rules:
 *   - $TICKER  → preserved as $ticker (lowercased, $ kept). $-prefix
 *               makes ticker mentions distinct from regular words
 *               sharing the spelling (e.g. $sol vs sol-the-protocol).
 *   - @handle  → preserved as @handle (lowercased). Author mentions
 *               often signal a controversy/announcement focal point.
 *   - #tag     → preserved as #tag (lowercased). Hashtags tend to be
 *               high-signal in event-driven cycles (#sxsw, #devcon).
 *   - https?://host/path → host (no www., no path). URL hosts trend
 *               around content drops (mirror.xyz, paragraph.xyz, ...).
 *   - regular tokens: split on non-alphanumeric, lowercase, drop
 *               length<3, drop stopwords, drop pure-numeric (except
 *               years 2020-2030 which have meaning).
 *
 * Exported for tests and future inspection commands.
 */
export function extractTermsFromTweet(tweet) {
  const text = tweet?.text;
  if (!text || typeof text !== 'string') return [];
  const seen = new Set();
  const out = [];

  // 1) Tickers, handles, hashtags, URLs first (they have a sigil and
  //    survive lowercasing). Ordering matters: do these BEFORE the
  //    generic word split so we don't tokenise "ETH" inside "$ETH".
  const sigilRe = /(\$[A-Za-z][A-Za-z0-9]{1,15})|(@[A-Za-z0-9_]{1,15})|(#[A-Za-z][A-Za-z0-9_]{1,40})|((?:https?:\/\/)([A-Za-z0-9.-]+)(?:\/[^\s]*)?)/g;
  let m;
  while ((m = sigilRe.exec(text))) {
    let term;
    if (m[1]) term = m[1].toLowerCase();           // $ticker
    else if (m[2]) term = m[2].toLowerCase();      // @handle
    else if (m[3]) term = m[3].toLowerCase();      // #tag
    else if (m[5]) {
      // URL host. Strip leading 'www.' so subdomain noise doesn't
      // split otherwise-identical mentions.
      const host = m[5].toLowerCase().replace(/^www\./, '');
      // Single-segment hosts ("localhost") and overlong ones probably
      // aren't trend-grade.
      if (host.length >= 4 && host.length <= 60 && host.includes('.')) {
        term = host;
      }
    }
    if (term && !seen.has(term)) {
      seen.add(term);
      out.push(term);
      if (out.length >= MAX_TOKENS_PER_TWEET) return out;
    }
  }

  // 2) Strip the stuff we already captured so it doesn't double-fire
  //    in the generic word split below.
  const stripped = text.replace(sigilRe, ' ');

  // 3) Generic word split. \p{L} keeps Cyrillic, accented chars, etc.
  //    (X is global; trend-tracking only English would miss a lot of
  //    real signal in non-English crypto subcommunities).
  const words = stripped.split(/[^\p{L}\p{N}']+/u);
  for (let raw of words) {
    raw = raw.toLowerCase();
    if (raw.length < 3 || raw.length > 24) continue;
    if (STOPWORDS.has(raw)) continue;
    // Drop pure-number tokens unless they look like a meaningful year.
    if (/^\d+$/.test(raw)) {
      const n = +raw;
      if (n < 2020 || n > 2030) continue;
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= MAX_TOKENS_PER_TWEET) break;
  }
  return out;
}

/**
 * Push a batch of tweets into the trend ledger for a given campaign.
 *
 * Does NOT block the caller; the runner already runs in a per-tick
 * task and we want it to finish fast. Errors are logged and
 * swallowed — a trend insert hiccup must never abort a feed scan.
 *
 * Async only because we periodically prune; the prune is the only
 * blocking work. If the caller wants to await it, they can; if they
 * don't, fire-and-forget is fine.
 */
export async function observe(campaignId, tweets) {
  if (!campaignId || !Array.isArray(tweets) || tweets.length === 0) return 0;
  const rows = [];
  const now = Date.now();
  for (const t of tweets) {
    if (!t || !t.id || !t.text) continue;
    const terms = extractTermsFromTweet(t);
    for (const term of terms) {
      rows.push({
        term,
        ts: now,
        tweet_id: String(t.id),
        author_handle: t.authorHandle || null,
        // Slice to keep DB compact; the full text already lives
        // wherever the runner persists matched tweets, this is for
        // /trends "show me an example" output.
        sample_text: t.text.slice(0, 300),
      });
    }
  }
  if (!rows.length) return 0;
  try {
    db.insertTrendObservations(campaignId, rows);
  } catch (e) {
    // Don't propagate — trend tracking is best-effort.
    logger.warn('trends', `observe insert failed: ${e.message}`);
    return 0;
  }
  // Periodic prune. Cheap most of the time (no rows older than the
  // cutoff), so guarding by time avoids a re-scan storm but keeps
  // the table bounded over weeks.
  if (now - _lastPruneAt > PRUNE_INTERVAL_MS) {
    _lastPruneAt = now;
    try {
      const deleted = db.pruneOldTrendObservations(DEFAULTS.pruneMaxAgeMs);
      if (deleted > 0) {
        logger.info('trends', `pruned ${deleted} old observations (>7d)`);
      }
    } catch (e) {
      logger.warn('trends', `prune failed: ${e.message}`);
    }
  }
  return rows.length;
}

/**
 * Compute current spike list for a campaign.
 *
 * Algorithm:
 *   recent  = count of term in last `recentWindowMs`
 *   base    = count of term in [recentWindowMs+baselineWindowMs, recentWindowMs] ago
 *   ratio   = (recent / recentWindowMs) / max(base / baselineWindowMs, EPS)
 *
 *   Term qualifies as a spike when:
 *     recent >= minRecentCount          (filter long-tail)
 *     ratio  >= minSpikeRatio           (must be growing)
 *
 *   Sort qualifying terms by ratio desc, take topN.
 *
 * EPS handles the cold-start / never-seen-before case: a term with
 * 5 mentions in the last 6h and 0 in the prior 18h is a real spike,
 * not a divide-by-zero. We treat 0 prior mentions as "0.5 / window"
 * so the resulting ratio is large but finite.
 *
 * Returns:
 *   [{ term, count, ratio, last_ts, last_tweet_id, last_sample_text,
 *      last_author_handle, baseline_count }, ...]
 */
export function topSpikes(campaignId, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = Date.now();
  const recent = db.trendCountsSince(campaignId, o.recentWindowMs, o.minRecentCount);
  if (!recent.length) return [];

  // Pull baseline counts for THESE terms only — much cheaper than
  // grouping the entire baseline window. We do it via per-term Maps
  // because trendCountsBetween returns an array of rows.
  const baselineFrom = now - (o.recentWindowMs + o.baselineWindowMs);
  const baselineTo = now - o.recentWindowMs;
  const baselineRows = db.trendCountsBetween(campaignId, baselineFrom, baselineTo, 0);
  const baselineByTerm = new Map(baselineRows.map((r) => [r.term, r.count]));

  const EPS = 0.5; // "half a mention" floor for never-seen terms
  const recentRate = (n) => n / o.recentWindowMs;
  const baselineRate = (n) => Math.max(n / o.baselineWindowMs, EPS / o.recentWindowMs);

  const scored = recent.map((r) => {
    const base = baselineByTerm.get(r.term) || 0;
    const ratio = recentRate(r.count) / baselineRate(base);
    return {
      term: r.term,
      count: r.count,
      baseline_count: base,
      ratio,
      last_ts: r.last_ts,
      last_tweet_id: r.last_tweet_id,
      last_sample_text: r.last_sample_text,
      last_author_handle: r.last_author_handle,
    };
  });

  return scored
    .filter((s) => s.ratio >= o.minSpikeRatio)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, o.topN);
}

// Tunables exposed for /trends to display in the UI when the user
// asks for context. Keeping the constants exportable also makes
// future config-driven thresholds (per-campaign customization)
// trivial to wire in.
export const TREND_DEFAULTS = DEFAULTS;
