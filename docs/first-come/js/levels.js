// Where levels come from: the shipped tables first, the generator beyond them.

import { CAMPAIGN, DAILY } from './levels-data.js';
import { parseLevel, N, E, S, W } from './engine.js';
import { campaignRecipe, dailyRecipe, generateOrRelax } from './gen.js';
import { dailyNumber, dayIndex } from './dates.js';

const cache = new Map();

function remember(key, make) {
  let level = cache.get(key);
  if (!level) {
    level = make();
    cache.set(key, level);
    if (cache.size > 12) cache.delete(cache.keys().next().value);
  }
  return level;
}

/** Campaign level `n`, 1-based. There is no last level. */
export function campaignLevel(n) {
  const num = Math.max(1, Math.floor(n));
  return remember(`c${num}`, () =>
    num <= CAMPAIGN.length ? parseLevel(CAMPAIGN[num - 1]) : generateOrRelax(`c/${num}`, campaignRecipe(num)),
  );
}

/** The Daily for a local date key (YYYY-MM-DD). The same for every player on that date. */
export function dailyLevel(key) {
  const num = dailyNumber(key);
  return remember(`d${num}`, () => {
    if (num >= 1 && num <= DAILY.length) return parseLevel(DAILY[num - 1]);
    if (num < 1) {
      // A device clock set before launch day still gets a puzzle.
      const wrapped = (((num - 1) % DAILY.length) + DAILY.length) % DAILY.length;
      return parseLevel(DAILY[wrapped]);
    }
    const weekday = new Date(dayIndex(key) * 86400000).getUTCDay();
    return generateOrRelax(`d/${num}`, dailyRecipe(num, weekday));
  });
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
