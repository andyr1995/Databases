// The game's sound effects, all synthesised.

import { tone, noise, midi } from './synth.js';

// A pentatonic ladder: a block's colour runs up it as it spreads, so every
// good tap plays a little rising figure. Each colour starts on its own rung.
const LADDER = [57, 60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84, 86, 88];

export const sfx = {
  /** Interface tap. */
  tap() {
    tone({ freq: 520, to: 380, dur: 0.05, type: 'triangle', vol: 0.12 });
  },

  /**
   * A block's colour spreads.
   * @param {number} colour  0..8
   * @param {number} steps   length of its longest arm
   * @param {number} stepMs  time between squares
   */
  claim(colour, steps, stepMs) {
    tone({ freq: 180, to: 120, dur: 0.07, type: 'sine', vol: 0.22 });
    const n = Math.min(steps, 9);
    for (let i = 0; i < n; i++) {
      const rung = (colour % 4) + i;
      tone({ freq: midi(LADDER[Math.min(rung, LADDER.length - 1)]), dur: 0.16, type: 'triangle', vol: 0.15, at: (i * stepMs) / 1000 });
    }
    noise({ dur: 0.03, vol: 0.05, freq: 2600, at: (n * stepMs) / 1000 });
  },

  /** A block with nowhere to go. */
  dud() {
    tone({ freq: 240, to: 200, dur: 0.07, type: 'triangle', vol: 0.1 });
  },

  /** A wrong tap: the colour runs out, then is pulled back. */
  slip() {
    tone({ freq: 196, to: 98, dur: 0.34, type: 'sawtooth', vol: 0.11 });
    tone({ freq: 185, to: 92, dur: 0.34, type: 'sawtooth', vol: 0.09 });
    noise({ dur: 0.12, vol: 0.12, freq: 220, kind: 'lowpass' });
  },

  /** The preview shown while a block is held. */
  peek() {
    tone({ freq: 880, dur: 0.05, type: 'sine', vol: 0.06 });
  },

  hint() {
    tone({ freq: midi(76), dur: 0.12, type: 'sine', vol: 0.18 });
    tone({ freq: midi(83), dur: 0.2, type: 'sine', vol: 0.18, at: 0.09 });
  },

  restart() {
    tone({ freq: 420, to: 300, dur: 0.09, type: 'triangle', vol: 0.14 });
  },

  /** A star lands. `n` is 0, 1 or 2. */
  star(n = 0) {
    tone({ freq: midi(72 + n * 4), dur: 0.22, type: 'triangle', vol: 0.22 });
    tone({ freq: midi(84 + n * 4), dur: 0.3, type: 'sine', vol: 0.1, at: 0.03 });
  },

  /** Board filled. */
  win() {
    [60, 64, 67, 72, 76].forEach((n, i) => {
      tone({ freq: midi(n), dur: 0.26, type: 'triangle', vol: 0.2, at: i * 0.075 });
    });
    tone({ freq: midi(84), dur: 0.5, type: 'sine', vol: 0.16, at: 0.4 });
  },

  /** Out of hearts. */
  lose() {
    [64, 60, 57, 52].forEach((n, i) => {
      tone({ freq: midi(n), dur: 0.3, type: 'triangle', vol: 0.18, at: i * 0.13 });
    });
  },
};
