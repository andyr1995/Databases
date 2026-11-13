import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_web.js';

const E = await load('engine.js');
const G = await load('gen.js');
const { createSession } = await load('session.js');
const { dailyShare, packStory, unpackStory } = await load('share.js');

const level3 = () => E.parseLevel(G.OPENING[2]); // block 1 must go before block 0
const level4 = () => E.parseLevel(G.OPENING[3]); // only order: 1, 0, 2

test('a slip is undone, counted and explained', () => {
  const s = createSession(level3());
  const before = s.position;
  const r = s.tap(0);
  assert.equal(r.kind, 'slip');
  assert.ok(r.stranded.length > 0);
  assert.ok(r.arms.some((arm) => arm.cells.length > 0), 'the arms are reported so they can be shown and pulled back');
  assert.equal(s.position, before, 'the board is exactly as it was');
  assert.equal(s.slips, 1);
  assert.equal(s.stars, 2);
  assert.deepEqual(s.story, [false]);
  assert.equal(s.tap(1).kind, 'claim');
  const last = s.tap(0);
  assert.equal(last.kind, 'claim');
  assert.ok(last.solved && s.solved);
  assert.deepEqual(s.story, [false, true, true]);
  assert.equal(s.tap(0), null, 'nothing can be tapped after the board is full');
});

test('a flawless solve earns three stars and the hint is always a safe block', () => {
  const s = createSession(level4());
  for (let i = 0; i < 3; i++) {
    const b = s.hint();
    assert.ok(b >= 0);
    assert.equal(s.tap(b).kind, 'claim');
  }
  assert.ok(s.solved);
  assert.equal(s.slips, 0);
  assert.equal(s.stars, 3);
  assert.equal(s.hint(), -1);
});

test('the same block cannot go twice and nonsense taps are ignored', () => {
  const s = createSession(level4());
  assert.equal(s.tap(1).kind, 'claim');
  assert.equal(s.tap(1), null);
  assert.equal(s.tap(-1), null);
  assert.equal(s.tap(99), null);
  assert.equal(s.remaining, 2);
});

test('the Daily ends on the third slip, and one more heart carries on from the same place', () => {
  const s = createSession(level4(), { hearts: 3 });
  assert.equal(s.heartsLeft, 3);
  assert.equal(s.tap(0).kind, 'slip');
  assert.equal(s.tap(2).kind, 'slip');
  const third = s.tap(0);
  assert.equal(third.kind, 'slip');
  assert.ok(third.lost && s.lost);
  assert.equal(s.heartsLeft, 0);
  assert.equal(s.tap(1), null, 'no taps once the hearts are gone');
  s.addHeart();
  assert.ok(!s.lost);
  assert.equal(s.heartsLeft, 1);
  assert.equal(s.tap(1).kind, 'claim');
});

test('a saved attempt replays to the same place', () => {
  const a = createSession(level4(), { hearts: 3 });
  a.tap(0);
  a.tap(1);
  a.tap(2);
  const b = createSession(level4(), { taps: a.taps, hearts: 3 });
  assert.deepEqual(b.taps, a.taps);
  assert.deepEqual(b.story, a.story);
  assert.equal(b.slips, a.slips);
  assert.deepEqual([...b.position.owner], [...a.position.owner]);
  // A lost attempt with an extra heart must be rebuilt with that heart, or later taps are dropped.
  const c = createSession(level4(), { taps: [0, 2, 0, 1, 0, 2], hearts: 4 });
  assert.ok(c.solved);
  assert.equal(c.slips, 3);
  const d = createSession(level4(), { taps: [0, 2, 0, 1, 0, 2], hearts: 3 });
  assert.ok(d.lost && !d.solved);
});

test('restart clears everything', () => {
  const s = createSession(level3());
  s.tap(0);
  s.tap(1);
  s.restart();
  assert.equal(s.slips, 0);
  assert.equal(s.taps.length, 0);
  assert.equal(s.position.claimed, 0);
  assert.equal(s.remaining, 2);
});

test('a block with nowhere to go just counts as gone', () => {
  //  >  .      The up-arrow block sits directly under the right-arrow block,
  //  ^  .      so it can never claim anything.
  const s = createSession(E.parseLevel('2:2:2.1_'));
  assert.equal(s.peek(1).reduce((n, arm) => n + arm.cells.length, 0), 0);
  assert.equal(s.tap(1).kind, 'empty');
  assert.equal(s.slips, 0);
  assert.equal(s.remaining, 1);
  assert.equal(s.tap(0).kind, 'claim');
  assert.ok(s.solved);
});

test('a win that leaves a block untapped reports the spare block and leaves none to go', () => {
  const s = createSession(E.parseLevel('3:1:2.8'));
  assert.equal(s.remaining, 2);
  const r = s.tap(1);
  assert.equal(r.kind, 'claim', 'filling the board is never a slip, whatever is left over');
  assert.ok(r.solved);
  assert.deepEqual(r.spare, [0]);
  assert.equal(s.remaining, 0);
  assert.equal(s.slips, 0);
  assert.equal(s.tap(0), null);
});

test('peek shows what a tap would claim without changing anything', () => {
  const s = createSession(level3());
  const cells = s.peek(1).flatMap((arm) => arm.cells);
  assert.ok(cells.length > 0);
  assert.equal(s.position.claimed, 0);
  assert.equal(s.taps.length, 0);
});

test('the share text tells the story without naming a block', () => {
  const won = dailyShare({ number: 12, story: [true, false, true, true], won: true, slips: 1, stars: 2, streak: 5 });
  assert.equal(won.text, 'First Come #12 ⭐⭐\n🟩🟥🟩🟩\nSolved with 1 slip\n🔥 5-day streak');
  assert.match(won.url, /^https:\/\//);
  const flawless = dailyShare({ number: 3, story: [true, true], won: true, slips: 0, stars: 3, streak: 1 });
  assert.equal(flawless.text, 'First Come #3 ⭐⭐⭐\n🟩🟩\nFlawless!');
  const lost = dailyShare({ number: 3, story: [false, true, false, false], won: false, slips: 3, stars: 0, streak: 0 });
  assert.equal(lost.text, 'First Come #3 💔\n🟥🟩🟥🟥\nOut of hearts');
  // A Daily solved with hints says so, and is never called flawless.
  const hinted = dailyShare({ number: 3, story: [true, true], won: true, slips: 0, hints: 2, stars: 3, streak: 1 });
  assert.equal(hinted.text, 'First Come #3 ⭐⭐⭐\n🟩🟩\nSolved with no slips 💡×2');
  assert.deepEqual(unpackStory(packStory([true, false, true])), [true, false, true]);
  assert.deepEqual(unpackStory(undefined), []);
});
