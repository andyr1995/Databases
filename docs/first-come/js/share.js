// The text a player sends to friends after the Daily. One square per tap, in
// the order they were made: green for a good tap, red for a slip. It shows how
// the solve went without giving away which block was which.

import { APP } from './config.js';

/**
 * @param {{number: number, story: boolean[], won: boolean, slips: number, stars: number, streak: number}} r
 * @returns {{title: string, text: string, url: string}}
 */
export function dailyShare(r) {
  const head = r.won ? '⭐'.repeat(r.stars) : '💔';
  const squares = r.story.map((good) => (good ? '🟩' : '🟥')).join('');
  const slips = r.slips === 0 ? 'no slips' : `${r.slips} ${r.slips === 1 ? 'slip' : 'slips'}`;
  const lines = [`${APP.name} #${r.number} ${head}`, squares, r.won ? (r.slips === 0 ? 'Flawless!' : `Solved with ${slips}`) : 'Out of hearts'];
  if (r.won && r.streak >= 2) lines.push(`🔥 ${r.streak}-day streak`);
  return { title: `${APP.name} #${r.number}`, text: lines.join('\n'), url: APP.url };
}

/** Compact storage of a story: '1' for a good tap, '0' for a slip. */
export const packStory = (story) => story.map((good) => (good ? '1' : '0')).join('');
export const unpackStory = (bits) => Array.from(bits || '', (ch) => ch === '1');
