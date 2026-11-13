// Calendar helpers for the Daily puzzle. Days are the player's LOCAL calendar
// days, so the puzzle rolls over at their midnight.

/** Daily #1 is this local date. */
export const DAILY_EPOCH = '2026-11-13';

const pad = (n) => String(n).padStart(2, '0');

/** @param {Date} [d] @returns {string} YYYY-MM-DD in local time */
export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Days since 1970-01-01 for a YYYY-MM-DD key (timezone independent). */
export function dayIndex(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

/** Whole days from key a to key b (b - a). */
export function daysBetween(a, b) {
  return dayIndex(b) - dayIndex(a);
}

/** 1-based number of the Daily for a date key. */
export function dailyNumber(key) {
  return daysBetween(DAILY_EPOCH, key) + 1;
}

/** Milliseconds until the next local midnight. */
export function msUntilTomorrow(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** "7h 12m" / "12m 05s" style countdown. */
export function formatCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m ${pad(s % 60)}s`;
}

/**
 * Streak the player is currently on, as of `today`.
 * A streak is alive if the last solve was today or yesterday.
 * @param {{streak:number,lastSolved:string|null}} daily
 */
export function liveStreak(daily, today = dateKey()) {
  if (!daily.lastSolved) return 0;
  const gap = daysBetween(daily.lastSolved, today);
  return gap === 0 || gap === 1 ? daily.streak : 0;
}

/**
 * Pure streak update for solving the Daily on `today`.
 * @returns {{streak:number,best:number,lastSolved:string}}
 */
export function applyDailySolve(daily, today = dateKey()) {
  if (daily.lastSolved === today) {
    return { streak: daily.streak, best: daily.best, lastSolved: today };
  }
  const continued = daily.lastSolved && daysBetween(daily.lastSolved, today) === 1;
  const streak = continued ? daily.streak + 1 : 1;
  return { streak, best: Math.max(daily.best || 0, streak), lastSolved: today };
}
