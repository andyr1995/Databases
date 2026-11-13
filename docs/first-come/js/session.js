// One attempt at one level. The list of taps is the whole truth: the board,
// the slip count and the share story are all replayed from it, which makes
// restart and "carry on where I left off" the same operation.

import { startPosition, play, isSolved, arms, createSolver, starsFor } from './engine.js';

/**
 * @param {import('./engine.js').Level} level
 * @param {{taps?: number[], hearts?: number}} [opts]
 *   taps: block indexes already tapped, in order (slips included)
 *   hearts: how many slips end the attempt (Infinity for the campaign)
 */
export function createSession(level, { taps = [], hearts = Infinity } = {}) {
  const solver = createSolver(level);
  let pos = startPosition(level);
  /** Every tap that counted, in order. */
  let log = [];
  /** One entry per tap that claimed or slipped: true = good, false = slip. */
  let story = [];
  let slips = 0;
  let maxSlips = hearts;

  const over = () => isSolved(level, pos) || slips >= maxSlips;

  /**
   * Apply one tap. Returns what happened, or null if the tap is not allowed.
   * @param {number} b
   */
  function apply(b) {
    if (!(b >= 0 && b < level.blocks.length) || pos.done & (1 << b) || over()) return null;
    const sent = arms(level, pos.owner, b);
    const next = play(level, pos, b);
    if (next.claimed === pos.claimed) {
      // Boxed in: nothing to claim. It simply counts as gone.
      pos = next;
      log.push(b);
      return { kind: /** @type {const} */ ('empty'), arms: sent };
    }
    if (!solver.solvable(next)) {
      slips++;
      story.push(false);
      log.push(b);
      return { kind: /** @type {const} */ ('slip'), arms: sent, stranded: solver.stranded(next), lost: slips >= maxSlips };
    }
    pos = next;
    story.push(true);
    log.push(b);
    const solved = isSolved(level, pos);
    /** Blocks that never needed to go; they pop for show when the board is full. */
    const spare = [];
    if (solved) {
      for (let i = 0; i < level.blocks.length; i++) if (!(pos.done & (1 << i))) spare.push(i);
    }
    return { kind: /** @type {const} */ ('claim'), arms: sent, solved, spare };
  }

  for (const b of taps) apply(b);

  return {
    level,
    get position() {
      return pos;
    },
    get taps() {
      return log;
    },
    get story() {
      return story;
    },
    get slips() {
      return slips;
    },
    get solved() {
      return isSolved(level, pos);
    },
    /** Out of hearts (Daily only). */
    get lost() {
      return !isSolved(level, pos) && slips >= maxSlips;
    },
    get heartsLeft() {
      return Math.max(0, maxSlips - slips);
    },
    get stars() {
      return starsFor(slips);
    },
    /** Blocks that have not gone yet (none once the board is full, even if one was never needed). */
    get remaining() {
      if (isSolved(level, pos)) return 0;
      let n = 0;
      for (let i = 0; i < level.blocks.length; i++) if (!(pos.done & (1 << i))) n++;
      return n;
    },

    tap: apply,

    /** What a block would claim if tapped now (for the hold-to-peek preview). */
    peek(b) {
      if (!(b >= 0 && b < level.blocks.length) || pos.done & (1 << b)) return [];
      return arms(level, pos.owner, b);
    },

    /** A block that is safe to tap now, or -1. */
    hint() {
      const safe = solver.safeBlocks(pos);
      return safe.length ? safe[0] : -1;
    },

    /** One more heart: the attempt carries on from the same position. */
    addHeart() {
      maxSlips++;
    },

    restart() {
      pos = startPosition(level);
      log = [];
      story = [];
      slips = 0;
    },
  };
}
