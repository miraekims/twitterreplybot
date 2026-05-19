// Tiny pub/sub for "the bot needs to tell its owner something out-of-band"
// — used today by the runner to alert when the Chrome extension is missing
// a captured GraphQL op shape (e.g. CreateTweet) and the user needs to do
// one manual action on x.com. Could be reused for any other operator-
// visible warnings later.
//
// Why not use the logger: logs go to docker stdout. The user is on
// Telegram, may not be tailing logs at 04:34 in the morning. They need a
// chat ping with a clear next-step.
//
// Why not import the Telegram bot directly from runner.js: would create a
// circular import (telegram → defaults → runner → telegram). Tiny module
// with a single function pointer keeps the dependency graph clean.

let _notifier = null;

// Called once from telegram/bot.js startup. fn signature:
//   fn(text: string, opts?: { keyboard?: TelegramInlineKeyboard }) → Promise<void>
export function setNotifier(fn) {
  _notifier = fn;
}

// Best-effort delivery. Returns true on success, false if no notifier
// registered or the delivery failed. Never throws — the caller should
// always be doing something else as their primary job.
export async function notifyOwners(text, opts = {}) {
  if (!_notifier) return false;
  try {
    await _notifier(text, opts);
    return true;
  } catch (e) {
    // Log but don't propagate — notification failure shouldn't break the
    // primary code path (a campaign tick, a webhook handler, ...).
    // eslint-disable-next-line no-console
    console.warn(`[notify] delivery failed: ${e && e.message}`);
    return false;
  }
}

// Per-key debounce. Common pattern: "alert about CreateTweet missing, but
// not more than once every 4 hours" — caller supplies a stable key like
// `op-missing:CreateTweet:c14`, we track lastSentAt in a Map.
const _debounceLastSent = new Map();

// Returns true if the message was sent (and the debounce key was bumped),
// false if the key is still hot.
export async function notifyOwnersDebounced(key, ttlMs, text, opts = {}) {
  const last = _debounceLastSent.get(key) || 0;
  if (Date.now() - last < ttlMs) return false;
  _debounceLastSent.set(key, Date.now());
  return notifyOwners(text, opts);
}

// Force-clear a debounce key. Useful when a previous condition cleared up
// (e.g. CreateTweet was just captured) so a future re-occurrence triggers
// a fresh alert immediately.
export function resetDebounce(key) {
  _debounceLastSent.delete(key);
}
