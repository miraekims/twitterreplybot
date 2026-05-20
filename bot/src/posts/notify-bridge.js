// Tiny re-export bridge so posts/scheduler.js doesn't need to import
// directly from core/notify.js. Decouples module ordering: notify.js
// is wired by telegram/bot.js at startup, and we want a single import
// point that callers can use safely even before wiring is complete.
//
// If the notifier hasn't been registered yet, calls degrade silently
// (same behavior as core/notify.js itself).
import { notifyOwners as _notifyOwners } from '../core/notify.js';

export const notifyOwners = _notifyOwners;
