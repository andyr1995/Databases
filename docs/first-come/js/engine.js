// The rules of First Come. Pure logic: no DOM, no randomness, no clocks.
//
// A board is a grid of squares with some blocks on it. Tapping a block sends
// its colour out along each of its arrows, claiming every free square in a
// straight line until something is in the way: the edge, a gap, another block,
// or a square that somebody already claimed. Each block goes once. The board is
// solved when every square is claimed, so the whole puzzle is the ORDER.

export const N = 1;
export const E = 2;
export const S = 4;
export const W = 8;
export const DIRS = [N, E, S, W];
const STEP_X = { [N]: 0, [E]: 1, [S]: 0, [W]: -1 };
const STEP_Y = { [N]: -1, [E]: 0, [S]: 1, [W]: 0 };

/**
 * @typedef {Object} Block
 * @property {number} cell   index of the square it sits on
 * @property {number} dirs   bitmask of N | E | S | W: which ways it reaches
 * @property {number} len    how far each arm may reach; 0 means "as far as it can"
 */

/**
 * @typedef {Object} Level
 * @property {number} w
 * @property {number} h
 * @property {Uint8Array} gap      1 where the board has no square
 * @property {Block[]} blocks
 * @property {Int8Array} blockAt   block index on each square, or -1
 * @property {number} squares      how many squares must be claimed
 */

/**
 * @typedef {Object} Position
 * @property {Int8Array} owner   which block claimed each square, or -1
 * @property {number} done       bitmask of blocks that have gone
 * @property {number} claimed    how many squares are claimed
 */

/** @param {Level} level @returns {Position} */
export function startPosition(level) {
  return { owner: new Int8Array(level.w * level.h).fill(-1), done: 0, claimed: 0 };
}

/**
 * The arms a block would send out right now.
 * @param {Level} level
 * @param {Int8Array} owner
 * @param {number} b  block index
 * @returns {Array<{dir: number, cells: number[]}>}  one entry per arrow, squares listed nearest first
 */
export function arms(level, owner, b) {
  const { w, h, gap, blockAt } = level;
  const block = level.blocks[b];
  const x0 = block.cell % w;
  const y0 = (block.cell - x0) / w;
  const out = [];
  for (const dir of DIRS) {
    if (!(block.dirs & dir)) continue;
    const cells = [];
    let x = x0 + STEP_X[dir];
    let y = y0 + STEP_Y[dir];
    while (x >= 0 && y >= 0 && x < w && y < h) {
      const i = y * w + x;
      if (gap[i] || blockAt[i] >= 0 || owner[i] >= 0) break;
      cells.push(i);
      if (block.len && cells.length >= block.len) break;
      x += STEP_X[dir];
      y += STEP_Y[dir];
    }
    out.push({ dir, cells });
  }
  return out;
}

/** Squares a block would claim right now, as a flat list. */
export function reach(level, owner, b) {
  const cells = [];
  for (const arm of arms(level, owner, b)) for (const c of arm.cells) cells.push(c);
  return cells;
}

/**
 * Let block `b` go. Returns the new position (the old one is not changed).
 * @param {Level} level @param {Position} pos @param {number} b
 * @returns {Position}
 */
export function play(level, pos, b) {
  const cells = reach(level, pos.owner, b);
  const owner = pos.owner.slice();
  for (const c of cells) owner[c] = b;
  return { owner, done: pos.done | (1 << b), claimed: pos.claimed + cells.length };
}

export const isSolved = (level, pos) => pos.claimed === level.squares;

/** Stars for finishing with this many slips. */
export function starsFor(slips) {
  return slips === 0 ? 3 : slips === 1 ? 2 : 1;
}

// ---- Solver ----------------------------------------------------------------

/**
 * Knows, for any position of one level, whether it can still be finished.
 * Positions are remembered, so every question after the first is nearly free.
 * @param {Level} level
 */
export function createSolver(level) {
  const count = level.blocks.length;
  const size = level.w * level.h;
  /** @type {Map<string, boolean>} */
  const memo = new Map();
  /** @type {Map<string, number>} */
  const bestMemo = new Map();
  const owner = new Int8Array(size);

  const keyOf = (done) => {
    let k = `${done}:`;
    for (let i = 0; i < size; i++) k += owner[i] >= 0 ? '1' : '0';
    return k;
  };

  function canFinish(done, claimed) {
    if (claimed === level.squares) return true;
    const key = keyOf(done);
    const known = memo.get(key);
    if (known !== undefined) return known;

    // A free square that no remaining block can reach is lost for good,
    // because a block's reach only ever shrinks as the board fills.
    const moves = [];
    const covered = new Uint8Array(size);
    let coveredCount = 0;
    for (let b = 0; b < count; b++) {
      if (done & (1 << b)) continue;
      const cells = reach(level, owner, b);
      if (!cells.length) continue;
      moves.push(b, cells);
      for (const c of cells) {
        if (!covered[c]) {
          covered[c] = 1;
          coveredCount++;
        }
      }
    }
    let result = false;
    if (coveredCount === level.squares - claimed) {
      for (let m = 0; m < moves.length && !result; m += 2) {
        const b = /** @type {number} */ (moves[m]);
        const cells = /** @type {number[]} */ (moves[m + 1]);
        for (const c of cells) owner[c] = b;
        result = canFinish(done | (1 << b), claimed + cells.length);
        for (const c of cells) owner[c] = -1;
      }
    }
    memo.set(key, result);
    return result;
  }

  /** Most squares that can still be claimed from here (used to show what a slip leaves bare). */
  function best(done, claimed) {
    if (claimed === level.squares) return claimed;
    const key = keyOf(done);
    const known = bestMemo.get(key);
    if (known !== undefined) return known;
    let top = claimed;
    for (let b = 0; b < count && top < level.squares; b++) {
      if (done & (1 << b)) continue;
      const cells = reach(level, owner, b);
      if (!cells.length) continue;
      for (const c of cells) owner[c] = b;
      const got = best(done | (1 << b), claimed + cells.length);
      for (const c of cells) owner[c] = -1;
      if (got > top) top = got;
    }
    bestMemo.set(key, top);
    return top;
  }

  const load = (pos) => owner.set(pos.owner);

  return {
    /** Can this position still be finished? */
    solvable(pos) {
      load(pos);
      return canFinish(pos.done, pos.claimed);
    },

    /** Blocks that are safe to tap now: tapping them keeps the board finishable. */
    safeBlocks(pos) {
      const safe = [];
      for (let b = 0; b < count; b++) {
        if (pos.done & (1 << b)) continue;
        const next = play(level, pos, b);
        if (next.claimed === pos.claimed) continue;
        load(next);
        if (canFinish(next.done, next.claimed)) safe.push(b);
      }
      return safe;
    },

    /**
     * Squares that would stay bare after the best possible follow-up from `pos`.
     * Empty if the position can still be finished.
     * @returns {number[]}
     */
    stranded(pos) {
      load(pos);
      // Follow one best line to its end and report what is left over.
      let done = pos.done;
      let claimed = pos.claimed;
      const target = best(done, claimed);
      while (claimed < target) {
        let moved = false;
        for (let b = 0; b < count; b++) {
          if (done & (1 << b)) continue;
          const cells = reach(level, owner, b);
          if (!cells.length) continue;
          for (const c of cells) owner[c] = b;
          if (best(done | (1 << b), claimed + cells.length) === target) {
            done |= 1 << b;
            claimed += cells.length;
            moved = true;
            break;
          }
          for (const c of cells) owner[c] = -1;
        }
        if (!moved) break;
      }
      const bare = [];
      for (let i = 0; i < size; i++) {
        if (!level.gap[i] && level.blockAt[i] < 0 && owner[i] < 0) bare.push(i);
      }
      return bare;
    },

    /** How many positions have been examined so far (a measure of the level's size). */
    get positions() {
      return memo.size;
    },
  };
}

/**
 * Measures of how hard a level is, from exploring every order.
 * @param {Level} level
 * @param {number} [cap] give up beyond this many positions
 * @returns {{solvable: boolean, luck: number, safeFirst: number, firstMoves: number, positions: number} | null}
 *   luck = the chance that tapping blocks at random, with no feedback, finishes the board
 */
export function measure(level, cap = 20000) {
  const count = level.blocks.length;
  const size = level.w * level.h;
  const owner = new Int8Array(size).fill(-1);
  /** @type {Map<string, {win: boolean, luck: number}>} */
  const memo = new Map();
  let over = false;

  function visit(done, claimed) {
    if (claimed === level.squares) return { win: true, luck: 1 };
    let key = `${done}:`;
    for (let i = 0; i < size; i++) key += owner[i] >= 0 ? '1' : '0';
    const known = memo.get(key);
    if (known) return known;
    if (memo.size >= cap) {
      over = true;
      return { win: false, luck: 0 };
    }
    let win = false;
    let luck = 0;
    let options = 0;
    for (let b = 0; b < count; b++) {
      if (done & (1 << b)) continue;
      const cells = reach(level, owner, b);
      if (!cells.length) continue;
      options++;
      for (const c of cells) owner[c] = b;
      const sub = visit(done | (1 << b), claimed + cells.length);
      for (const c of cells) owner[c] = -1;
      if (sub.win) win = true;
      luck += sub.luck;
    }
    const result = { win, luck: options ? luck / options : 0 };
    memo.set(key, result);
    return result;
  }

  const top = visit(0, 0);
  if (over) return null;
  let safeFirst = 0;
  let firstMoves = 0;
  for (let b = 0; b < count; b++) {
    const cells = reach(level, owner, b);
    if (!cells.length) continue;
    firstMoves++;
    for (const c of cells) owner[c] = b;
    if (visit(1 << b, cells.length).win) safeFirst++;
    for (const c of cells) owner[c] = -1;
  }
  return { solvable: top.win, luck: top.luck, safeFirst, firstMoves, positions: memo.size };
}

// ---- Text form -------------------------------------------------------------
// "w:h:grid[:lengths]", one character per square, row by row:
//   _  gap (no square)     .  free square
//   1-f  a block; the hex digit is its arrows (N=1, E=2, S=4, W=8; f = all four)
// `lengths` (optional) has one digit per block in reading order: how far its arms
// reach, 0 for "as far as they can".

/** @param {string} text @returns {Level} */
export function parseLevel(text) {
  const [ws, hs, grid, lengths = ''] = text.split(':');
  const w = Number(ws);
  const h = Number(hs);
  if (!(w > 0 && h > 0) || !grid || grid.length !== w * h) throw new Error(`Bad level: ${text}`);
  const gap = new Uint8Array(w * h);
  const blockAt = new Int8Array(w * h).fill(-1);
  /** @type {Block[]} */
  const blocks = [];
  let squares = 0;
  for (let i = 0; i < grid.length; i++) {
    const ch = grid[i];
    if (ch === '_') gap[i] = 1;
    else if (ch === '.') squares++;
    else {
      const dirs = parseInt(ch, 16);
      if (!(dirs >= 1 && dirs <= 15)) throw new Error(`Bad level character "${ch}" in ${text}`);
      blockAt[i] = blocks.length;
      blocks.push({ cell: i, dirs, len: Number(lengths[blocks.length] || 0) });
    }
  }
  if (blocks.length > 30) throw new Error(`Too many blocks in ${text}`);
  return { w, h, gap, blocks, blockAt, squares };
}

/** @param {Level} level @returns {string} */
export function formatLevel(level) {
  let grid = '';
  for (let i = 0; i < level.gap.length; i++) {
    if (level.gap[i]) grid += '_';
    else if (level.blockAt[i] >= 0) grid += level.blocks[level.blockAt[i]].dirs.toString(16);
    else grid += '.';
  }
  // Lengths are listed in reading order, which is how parseLevel numbers the blocks.
  const lengths = [...level.blocks]
    .sort((a, b) => a.cell - b.cell)
    .map((b) => String(b.len || 0))
    .join('');
  return `${level.w}:${level.h}:${grid}${/[1-9]/.test(lengths) ? `:${lengths}` : ''}`;
}
