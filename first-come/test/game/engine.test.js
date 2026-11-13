import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_web.js';

const E = await load('engine.js');
const G = await load('gen.js');
const { makeRng } = await load('rng.js');

/** Every order of the blocks, tried the slow way: does any fill the board, and how likely is a random order to? */
function bruteForce(level) {
  const n = level.blocks.length;
  let anyWin = false;
  function walk(pos) {
    if (E.isSolved(level, pos)) {
      anyWin = true;
      return 1;
    }
    const options = [];
    for (let b = 0; b < n; b++) {
      if (pos.done & (1 << b)) continue;
      if (E.reach(level, pos.owner, b).length) options.push(b);
    }
    if (!options.length) return 0;
    let p = 0;
    for (const b of options) p += walk(E.play(level, pos, b));
    return p / options.length;
  }
  const luck = walk(E.startPosition(level));
  return { anyWin, luck };
}

/** The most squares that can ever be claimed from a position, the slow way. */
function bruteBest(level, pos) {
  let best = pos.claimed;
  for (let b = 0; b < level.blocks.length; b++) {
    if (pos.done & (1 << b)) continue;
    if (!E.reach(level, pos.owner, b).length) continue;
    best = Math.max(best, bruteBest(level, E.play(level, pos, b)));
  }
  return best;
}

/** A random board that was NOT built from a solution, so it is often unsolvable. */
function randomLevel(rng) {
  const w = 3 + rng.int(3);
  const h = 3 + rng.int(3);
  let grid = '';
  let blocks = 0;
  for (let i = 0; i < w * h; i++) {
    const roll = rng.next();
    if (roll < 0.14) grid += '_';
    else if (roll < 0.34 && blocks < 6) {
      grid += (1 + rng.int(15)).toString(16);
      blocks++;
    } else grid += '.';
  }
  if (!blocks || !grid.includes('.')) return null;
  let lengths = '';
  for (let b = 0; b < blocks; b++) lengths += rng.chance(0.25) ? String(1 + rng.int(3)) : '0';
  return E.parseLevel(`${w}:${h}:${grid}:${lengths}`);
}

test('level text survives a round trip', () => {
  for (const text of ['5:2:..f._f....', '6:3:...f.._._..f_f....', '3:3:5..a.1...:201']) {
    assert.equal(E.formatLevel(E.parseLevel(text)), text);
  }
  assert.throws(() => E.parseLevel('3:3:....'));
  assert.throws(() => E.parseLevel('2:1:.z'));
});

test('an arm stops at the edge, a gap, another block and a claimed square', () => {
  //  . . f . _
  //  f . . . .
  const level = E.parseLevel('5:2:..f._f....');
  const pos = E.startPosition(level);
  // Block 0 at (2,0): west two squares, east one (then a gap), south one (then the edge).
  assert.deepEqual(E.arms(level, pos.owner, 0), [
    { dir: E.N, cells: [] },
    { dir: E.E, cells: [3] },
    { dir: E.S, cells: [7] },
    { dir: E.W, cells: [1, 0] },
  ]);
  // After block 0 goes, block 1's east arm is cut short by the claimed square at (2,1).
  const after = E.play(level, pos, 0);
  assert.deepEqual(E.reach(level, after.owner, 1), [6]);
  // play() must not change the position it was given.
  assert.equal(pos.claimed, 0);
  assert.ok(pos.owner.every((o) => o === -1));
});

test('a number on a block limits each arm', () => {
  const level = E.parseLevel('5:1:f....:2');
  assert.deepEqual(E.reach(level, E.startPosition(level).owner, 0), [1, 2]);
});

test('the tutorial levels teach what they claim to', () => {
  const [one, two, three, four] = G.OPENING.map(E.parseLevel);
  assert.equal(one.blocks.length, 1);
  assert.ok(E.isSolved(one, E.play(one, E.startPosition(one), 0)), 'level 1 is one tap');
  assert.equal(bruteForce(two).luck, 1, 'level 2 cannot be got wrong');
  assert.equal(E.createSolver(three).safeBlocks(E.startPosition(three)).length, 1, 'level 3 has one right first tap');
  assert.equal(bruteForce(four).luck, 1 / 6, 'level 4 has exactly one winning order out of six');
});

test('the solver agrees with brute force on generated levels', () => {
  let checked = 0;
  for (let i = 0; checked < 150 && i < 4000; i++) {
    const rng = makeRng(`solver-check/${i}`);
    const level = G.construct(rng, { w: 5, h: 5 + (i % 2), blocks: 3 + (i % 4), shapes: i % 3 ? 'bends' : 'plus', short: i % 5 ? 0 : 0.4, gaps: 2 });
    if (!level) continue;
    checked++;
    const truth = bruteForce(level);
    const solver = E.createSolver(level);
    const start = E.startPosition(level);
    assert.equal(solver.solvable(start), truth.anyWin, `solvable? ${E.formatLevel(level)}`);
    assert.ok(truth.anyWin, 'built-from-a-solution levels are always solvable');
    const m = E.measure(level);
    assert.ok(Math.abs(m.luck - truth.luck) < 1e-9, `luck ${m.luck} vs ${truth.luck} for ${E.formatLevel(level)}`);

    // Walk the level by always taking a block the solver calls safe: it must end solved.
    let pos = start;
    for (let step = 0; step < 20 && !E.isSolved(level, pos); step++) {
      const safe = solver.safeBlocks(pos);
      assert.ok(safe.length > 0, 'a solvable position always has a safe block');
      // Every block NOT called safe really does make the board unfinishable.
      for (let b = 0; b < level.blocks.length; b++) {
        if (pos.done & (1 << b) || safe.includes(b)) continue;
        const next = E.play(level, pos, b);
        if (next.claimed === pos.claimed) continue;
        assert.equal(solver.solvable(next), false);
        const bare = solver.stranded(next);
        assert.equal(bare.length, level.squares - bruteBest(level, next), 'exactly the squares the best follow-up leaves bare');
        assert.ok(bare.length > 0, 'a slip always has stranded squares to show');
        for (const cell of bare) assert.equal(next.owner[cell], -1, 'stranded squares are free squares');
      }
      pos = E.play(level, pos, safe[0]);
    }
    assert.ok(E.isSolved(level, pos));
    assert.deepEqual(solver.stranded(start), [], 'nothing is stranded in a solvable position');
  }
  assert.ok(checked >= 150, `only ${checked} levels were checked`);
});

test('the solver agrees with brute force on random boards, solvable or not, at every position', () => {
  const rng = makeRng('random-boards');
  let checked = 0;
  let unsolvable = 0;
  for (let i = 0; checked < 400 && i < 5000; i++) {
    const level = randomLevel(rng);
    if (!level) continue;
    checked++;
    const solver = E.createSolver(level);
    const squares = level.squares;
    // Visit every position reachable by any order of taps.
    const seen = new Set();
    const visit = (pos) => {
      const key = `${pos.done}:${Array.from(pos.owner, (o) => (o >= 0 ? 1 : 0)).join('')}`;
      if (seen.has(key)) return;
      seen.add(key);
      const best = bruteBest(level, pos);
      assert.equal(solver.solvable(pos), best === squares, `solvable at ${key} of ${E.formatLevel(level)}`);
      assert.equal(solver.stranded(pos).length, squares - best, `stranded at ${key} of ${E.formatLevel(level)}`);
      const safe = solver.safeBlocks(pos);
      for (let b = 0; b < level.blocks.length; b++) {
        if (pos.done & (1 << b)) continue;
        const next = E.play(level, pos, b);
        if (next.claimed === pos.claimed) {
          assert.ok(!safe.includes(b), 'a block with nothing to claim is never offered as a hint');
          continue;
        }
        assert.equal(safe.includes(b), bruteBest(level, next) === squares, `is block ${b} safe at ${key} of ${E.formatLevel(level)}`);
        visit(next);
      }
    };
    const start = E.startPosition(level);
    if (bruteBest(level, start) !== squares) unsolvable++;
    visit(start);
  }
  assert.ok(checked >= 400);
  assert.ok(unsolvable > 50, `unsolvable boards must be exercised too (${unsolvable})`);
});

test('the board can fill while a block is still waiting, and that is a win', () => {
  //  >  .  <   Either block fills the one free square; the other is never needed.
  const level = E.parseLevel('3:1:2.8');
  const after = E.play(level, E.startPosition(level), 0);
  assert.ok(E.isSolved(level, after));
  assert.equal(after.done, 1);
  assert.ok(E.createSolver(level).solvable(after));
  assert.deepEqual(E.createSolver(level).safeBlocks(E.startPosition(level)), [0, 1]);
});

test('stars follow slips', () => {
  assert.deepEqual([0, 1, 2, 7].map(E.starsFor), [3, 2, 1, 1]);
});
