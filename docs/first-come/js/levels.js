// Where levels come from: the shipped tables first, the generator beyond them.
// A table entry is exactly what the generator would produce for that number,
// saved ahead of time, so nothing changes at the point where the tables end.

import { CAMPAIGN, DAILY } from './levels-data.js';
import { parseLevel, N, E, S, W } from './engine.js';
import { campaignRecipe, dailyRecipe, levelSearch } from './gen.js';
import { dailyNumber, dayIndex } from './dates.js';

/** Recently used levels, by key. */
const cache = new Map();
/** Searches for generated levels that are under way in the background, by key. */
const searches = new Map();

function keep(key, level) {
  cache.set(key, level);
  if (cache.size > 12) cache.delete(cache.keys().next().value);
  return level;
}

const finish = (search) => {
  for (;;) {
    const step = search.next();
    if (step.done) return step.value;
  }
};

/** Run a search to the end now, picking up a background search if one has started. */
function generated(key, start) {
  const search = searches.get(key) || start();
  searches.delete(key);
  return finish(search);
}

const campaignSearch = (num) => () => levelSearch(`c/${num}`, campaignRecipe(num));

/** Campaign level `n`, 1-based. There is no last level. */
export function campaignLevel(n) {
  const num = Math.max(1, Math.floor(n));
  const key = `c${num}`;
  return (
    cache.get(key) ||
    keep(key, num <= CAMPAIGN.length ? parseLevel(CAMPAIGN[num - 1]) : generated(key, campaignSearch(num)))
  );
}

/**
 * Get campaign level `n` ready ahead of time. Levels beyond the shipped table
 * are built by trial and error, which can take a second or two on a slow phone,
 * so the work is done a few milliseconds at a time while the player is busy
 * with something else. Asking for the level before it is ready simply finishes
 * the same search on the spot.
 */
export function prepareCampaignLevel(n) {
  const num = Math.max(1, Math.floor(n));
  const key = `c${num}`;
  if (num <= CAMPAIGN.length || cache.has(key) || searches.has(key)) return;
  const search = campaignSearch(num)();
  searches.set(key, search);
  const slice = () => {
    if (searches.get(key) !== search) return;
    const until = performance.now() + 6;
    do {
      const step = search.next();
      if (step.done) {
        searches.delete(key);
        keep(key, step.value);
        return;
      }
    } while (performance.now() < until);
    setTimeout(slice, 30);
  };
  setTimeout(slice, 30);
}

/** The Daily for a local date key (YYYY-MM-DD). The same for every player on that date. */
export function dailyLevel(key) {
  const num = dailyNumber(key);
  const cacheKey = `d${num}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  if (num >= 1 && num <= DAILY.length) return keep(cacheKey, parseLevel(DAILY[num - 1]));
  if (num < 1) {
    // A device clock set before launch day still gets a puzzle.
    const wrapped = (((num - 1) % DAILY.length) + DAILY.length) % DAILY.length;
    return keep(cacheKey, parseLevel(DAILY[wrapped]));
  }
  const weekday = new Date(dayIndex(key) * 86400000).getUTCDay();
  return keep(cacheKey, generated(cacheKey, () => levelSearch(`d/${num}`, dailyRecipe(num, weekday))));
}

const ALL = N | E | S | W;
const STRAIGHT = new Set([N, E, S, W, N | S, E | W]);

/** Which kinds of block a level contains (each is explained the first time it appears). */
export function featuresOf(level) {
  const f = { lines: false, bends: false, short: false };
  for (const block of level.blocks) {
    if (block.len) f.short = true;
    if (block.dirs === ALL) continue;
    if (STRAIGHT.has(block.dirs)) f.lines = true;
    else f.bends = true;
  }
  return f;
}
