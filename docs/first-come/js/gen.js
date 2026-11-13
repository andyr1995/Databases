// Level generation. Pure and deterministic: the same seed and recipe always
// give the same level, on every device.
//
// Levels are built backwards from a solution: blocks are dropped onto an empty
// board one at a time and each goes straight away, so the order they were
// dropped in is a guaranteed way to finish. The solver then measures how hard
// the level is, and levels outside the wanted band are thrown away.

import { makeRng } from './rng.js';
import { N, E, S, W, arms, reach, measure, formatLevel, parseLevel } from './engine.js';

const ALL = N | E | S | W;
/** Shape pools. Repeats make a shape more likely. */
export const SHAPES = {
  plus: [ALL],
  lines: [ALL, ALL, ALL, E | W, N | S, N, E, S, W],
  bends: [ALL, ALL, E | W, N | S, N, E, S, W, N | E, E | S, S | W, W | N, N | E | S, E | S | W, S | W | N, W | N | E],
};

/**
 * @typedef {Object} Recipe
 * @property {number} w
 * @property {number} h
 * @property {number} blocks
 * @property {keyof typeof SHAPES} shapes
 * @property {number} [gaps]       gaps punched before building (mirrored for a tidy outline)
 * @property {number} [short]      chance that a block gets a limited reach
 * @property {number} luckMin      wanted band for "a random tapper finishes it"
 * @property {number} luckMax
 * @property {boolean} [beatBots]  reject levels that an obvious habit solves
 * @property {'arrows'|'number'} [need]  must contain a block with fewer than four arrows / a number that matters
 */

function connected(gap, w, h) {
  let first = -1;
  let open = 0;
  for (let i = 0; i < gap.length; i++) {
    if (!gap[i]) {
      open++;
      if (first < 0) first = i;
    }
  }
  if (first < 0) return false;
  const seen = new Uint8Array(gap.length);
  const stack = [first];
  seen[first] = 1;
  let got = 0;
  while (stack.length) {
    const i = stack.pop();
    got++;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0 && !gap[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), stack.push(i - 1);
    if (x < w - 1 && !gap[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), stack.push(i + 1);
    if (y > 0 && !gap[i - w] && !seen[i - w]) (seen[i - w] = 1), stack.push(i - w);
    if (y < h - 1 && !gap[i + w] && !seen[i + w]) (seen[i + w] = 1), stack.push(i + w);
  }
  return got === open;
}

/** Cut away rows and columns that are nothing but gaps. */
function crop(level) {
  const { w, h, gap } = level;
  let x0 = w;
  let x1 = -1;
  let y0 = h;
  let y1 = -1;
  for (let i = 0; i < gap.length; i++) {
    if (gap[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1) return level;
  const nw = x1 - x0 + 1;
  const nh = y1 - y0 + 1;
  const grid = formatLevel(level).split(':')[2];
  let out = '';
  for (let y = y0; y <= y1; y++) out += grid.slice(y * w + x0, y * w + x1 + 1);
  const lengths = level.blocks.map((b) => String(b.len || 0)).join('');
  return parseLevel(`${nw}:${nh}:${out}${/[1-9]/.test(lengths) ? `:${lengths}` : ''}`);
}

/** Would an obvious habit solve it without thinking? */
function botSolves(level, choose) {
  const owner = new Int8Array(level.w * level.h).fill(-1);
  let done = 0;
  let claimed = 0;
  for (;;) {
    if (claimed === level.squares) return true;
    const moves = [];
    for (let b = 0; b < level.blocks.length; b++) {
      if (done & (1 << b)) continue;
      const cells = reach(level, owner, b);
      if (cells.length) moves.push({ b, cells });
    }
    if (!moves.length) return false;
    const pick = choose(moves);
    for (const c of pick.cells) owner[c] = pick.b;
    done |= 1 << pick.b;
    claimed += pick.cells.length;
  }
}
const BOTS = [
  (moves) => moves.reduce((a, m) => (m.cells.length > a.cells.length ? m : a)),
  (moves) => moves.reduce((a, m) => (m.cells.length < a.cells.length ? m : a)),
  (moves) => moves[0],
  (moves) => moves[moves.length - 1],
];
export const anyBotSolves = (level) => BOTS.some((bot) => botSolves(level, bot));

/**
 * Remove decoration that could mislead: an arrow that points straight at a wall
 * can never claim anything, and a number that is at least as long as every arm
 * limits nothing. Neither change can alter the puzzle, because a block's reach
 * on the empty board is the most it will ever have.
 * Plus blocks are left alone so that the early levels keep a single block shape.
 * @param {import('./engine.js').Level} level  as built: `squares` is not relied on
 */
function tidy(level) {
  const empty = new Int8Array(level.w * level.h).fill(-1);
  level.blocks.forEach((block, b) => {
    const free = { ...block, len: 0 };
    const sent = arms({ ...level, blocks: level.blocks.map((x, i) => (i === b ? free : x)) }, empty, b);
    let longest = 0;
    let dirs = 0;
    for (const arm of sent) {
      if (arm.cells.length) dirs |= arm.dir;
      if (arm.cells.length > longest) longest = arm.cells.length;
    }
    if (block.dirs !== ALL && dirs) block.dirs = dirs;
    if (block.len && block.len >= longest) block.len = 0;
  });
}

/**
 * Build one candidate. Returns null if this roll does not make a usable board.
 * @param {ReturnType<typeof makeRng>} rng
 * @param {Recipe} recipe
 * @returns {import('./engine.js').Level|null}
 */
export function construct(rng, recipe) {
  const { w, h } = recipe;
  const size = w * h;
  const gap = new Uint8Array(size);
  const blockAt = new Int8Array(size).fill(-1);
  const owner = new Int8Array(size).fill(-1);
  const pool = SHAPES[recipe.shapes];

  const mirror = rng.chance(0.65);
  for (let k = 0; k < (recipe.gaps || 0); k++) {
    const x = rng.int(w);
    const y = rng.int(h);
    gap[y * w + x] = 1;
    if (mirror) gap[y * w + (w - 1 - x)] = 1;
  }

  /** @type {import('./engine.js').Level} */
  const level = { w, h, gap, blocks: [], blockAt, squares: 0 };
  // How strongly new blocks prefer long reaches. Varies per level so the hidden
  // order is not always "biggest first".
  const taste = rng.int(3);

  for (let k = 0; k < recipe.blocks; k++) {
    const dirs = rng.pick(pool);
    const len = recipe.short && rng.chance(recipe.short) ? rng.range(1, 3) : 0;
    const spots = [];
    let total = 0;
    for (let c = 0; c < size; c++) {
      if (gap[c] || blockAt[c] >= 0 || owner[c] >= 0) continue;
      level.blocks.push({ cell: c, dirs, len });
      blockAt[c] = level.blocks.length - 1;
      const gain = reach(level, owner, level.blocks.length - 1).length;
      blockAt[c] = -1;
      level.blocks.pop();
      if (gain >= 2) {
        const weight = Math.pow(gain, taste);
        spots.push(c, weight);
        total += weight;
      }
    }
    if (!spots.length) return null;
    let roll = rng.next() * total;
    let chosen = spots[0];
    for (let i = 0; i < spots.length; i += 2) {
      roll -= spots[i + 1];
      if (roll <= 0) {
        chosen = spots[i];
        break;
      }
    }
    const index = level.blocks.length;
    level.blocks.push({ cell: chosen, dirs, len });
    blockAt[chosen] = index;
    for (const c of reach(level, owner, index)) owner[c] = index;
  }

  // Whatever nobody claimed becomes a gap.
  let gaps = 0;
  for (let c = 0; c < size; c++) {
    if (!gap[c] && blockAt[c] < 0 && owner[c] < 0) gap[c] = 1;
    if (gap[c]) gaps++;
  }
  if (gaps / size > 0.3) return null;
  if (!connected(gap, w, h)) return null;

  tidy(level);
  if (recipe.need === 'arrows' && !level.blocks.some((b) => b.dirs !== ALL)) return null;
  if (recipe.need === 'number' && !level.blocks.some((b) => b.len)) return null;

  // Re-read through the text form so blocks are numbered in reading order.
  return crop(parseLevel(formatLevel(level)));
}

/** Does a built candidate fit the recipe's difficulty band? */
function fits(level, recipe) {
  const m = measure(level);
  if (!m || !m.solvable) return false;
  if (m.luck < recipe.luckMin || m.luck > recipe.luckMax) return false;
  if (recipe.beatBots && anyBotSolves(level)) return false;
  return true;
}

/**
 * The whole search for one level, as a generator that pauses after every
 * candidate. Draining it in one go and stepping it a few milliseconds at a time
 * give exactly the same level, which lets a phone build a level in the
 * background without freezing.
 *
 * Candidates are tried in a fixed, seeded order. If the recipe cannot be met it
 * is loosened step by step rather than failing.
 * @param {string} seed
 * @param {Recipe} recipe
 * @returns {Generator<undefined, import('./engine.js').Level, void>}
 */
export function* levelSearch(seed, recipe) {
  for (let t = 0; t < 6000; t++) {
    const level = construct(makeRng(`${seed}/${t}`), recipe);
    if (level && fits(level, recipe)) return level;
    yield;
  }
  let r = recipe;
  for (let round = 0; round < 4; round++) {
    for (let t = 0; t < 3000; t++) {
      const level = construct(makeRng(`${seed}/r${round}/${t}`), r);
      if (level && fits(level, r)) return level;
      yield;
    }
    r = { ...r, luckMin: r.luckMin / 2, luckMax: Math.min(1, r.luckMax * 1.6), beatBots: false, need: undefined };
    if (round >= 1 && r.blocks > 3) r = { ...r, blocks: r.blocks - 1 };
  }
  // A tiny board that always exists.
  const last = { w: 5, h: 5, blocks: 3, shapes: /** @type {const} */ ('plus'), gaps: 2, luckMin: 0, luckMax: 1 };
  for (let t = 0; ; t++) {
    const level = construct(makeRng(`${seed}/fallback/${t}`), last);
    if (level && fits(level, last)) return level;
    yield;
  }
}

/**
 * Generate the level for a seed and recipe. The shipped tables are simply this
 * function's output saved ahead of time, so a level is the same whether it comes
 * from a table or is built on the device.
 * @param {string} seed
 * @param {Recipe} recipe
 * @returns {import('./engine.js').Level}
 */
export function makeLevel(seed, recipe) {
  const search = levelSearch(seed, recipe);
  for (;;) {
    const step = search.next();
    if (step.done) return step.value;
  }
}

// ---- Recipes ---------------------------------------------------------------

/** Levels 1-4 are written by hand and teach the game one idea at a time. */
export const OPENING = ['5:5:__.____.__..f..__.____.__', '4:3:f....__....f', '5:2:..f._f....', '6:3:...f.._._..f_f....'];

/** Where each new kind of block first appears, with a gentle first outing. */
export const INTRO = { lines: 15, bends: 40, short: 80 };

/** Difficulty within a chapter of ten: a ramp, a breather in the middle, a peak at the end. */
const CHAPTER = [1.3, 1.15, 1, 0.9, 1.8, 0.85, 0.75, 0.65, 0.6, 0.4];

/**
 * Recipe for campaign level `n` (1-based, n > OPENING.length). Deterministic in n.
 * @returns {Recipe}
 */
export function campaignRecipe(n) {
  const rng = makeRng(`recipe/${n}`);
  const boss = n % 10 === 0;
  const factor = CHAPTER[(n - 1) % 10];

  if (n === INTRO.lines) return { w: 5, h: 5, blocks: 3, shapes: 'lines', gaps: 2, luckMin: 0.3, luckMax: 1, need: 'arrows' };
  if (n === INTRO.bends) return { w: 5, h: 6, blocks: 4, shapes: 'bends', gaps: 2, luckMin: 0.25, luckMax: 1, need: 'arrows' };
  if (n === INTRO.short) return { w: 5, h: 6, blocks: 4, shapes: 'lines', short: 0.6, gaps: 2, luckMin: 0.25, luckMax: 1, need: 'number' };

  /** @type {Recipe} */
  let r;
  if (n <= 10) {
    r = { w: 5, h: n <= 7 ? 5 : 6, blocks: n <= 7 ? 3 : 4, shapes: 'plus', gaps: 2, luckMin: 0.2, luckMax: 0.55 };
  } else if (n < INTRO.lines) {
    r = { w: 5 + rng.int(2), h: 6, blocks: rng.range(4, 5), shapes: 'plus', gaps: 3, luckMin: 0.12, luckMax: 0.36 };
  } else if (n < INTRO.bends) {
    const late = n >= 28;
    r = { w: 6, h: late ? 7 : 6, blocks: rng.range(late ? 5 : 4, late ? 6 : 5), shapes: 'lines', gaps: 4, luckMin: 0.07, luckMax: 0.26, beatBots: true };
  } else if (n < INTRO.short) {
    r = { w: 6, h: 7, blocks: rng.range(5, 7), shapes: 'bends', gaps: 4, luckMin: 0.04, luckMax: 0.18, beatBots: true };
  } else if (n < 150) {
    r = { w: 6 + rng.int(2), h: 8, blocks: rng.range(6, 8), shapes: 'bends', short: 0.25, gaps: 5, luckMin: 0.02, luckMax: 0.11, beatBots: true };
  } else {
    r = { w: 7, h: 8 + rng.int(2), blocks: rng.range(7, 9), shapes: 'bends', short: 0.25, gaps: 6, luckMin: 0.006, luckMax: 0.07, beatBots: true };
  }
  r.luckMin = Math.min(0.9, r.luckMin * factor);
  r.luckMax = Math.min(1, r.luckMax * factor);
  if (boss && r.blocks < 9) r.blocks++;
  return r;
}

/**
 * Recipe for the Daily. Mondays are gentle; Sunday is the hardest.
 * @param {number} number  1-based daily number
 * @param {number} weekday 0 = Sunday ... 6 = Saturday
 * @returns {Recipe}
 */
export function dailyRecipe(number, weekday) {
  const rng = makeRng(`daily-recipe/${number}`);
  const day = (weekday + 6) % 7; // Mon..Sun => 0..6
  const blocks = [5, 6, 6, 7, 7, 8, 9][day];
  const luckMax = [0.3, 0.22, 0.16, 0.12, 0.09, 0.07, 0.05][day];
  return {
    w: day >= 5 ? 7 : 6,
    h: day >= 3 ? 8 : 7,
    blocks,
    shapes: 'bends',
    short: day >= 2 ? 0.2 : 0,
    gaps: rng.range(3, 6),
    luckMin: luckMax / 5,
    luckMax,
    beatBots: true,
  };
}
