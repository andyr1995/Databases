import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_web.js';

const E = await load('engine.js');
const G = await load('gen.js');
const { CAMPAIGN, DAILY } = await load('levels-data.js');
const { DAILY_EPOCH, dayIndex, dateKey } = await load('dates.js');
const L = await load('levels.js');

const ALL = E.N | E.E | E.S | E.W;
const text = (level) => E.formatLevel(level);
/** The date key `days` after launch day. */
const dayKey = (days) => {
  const [y, m, d] = DAILY_EPOCH.split('-').map(Number);
  return dateKey(new Date(y, m - 1, d + days));
};
const weekdayOf = (number) => new Date((dayIndex(DAILY_EPOCH) + number - 1) * 86400000).getUTCDay();

test('generation is deterministic, and stepping the search gives the same level as running it', () => {
  for (const n of [5, 17, 42, 99, 160, 2001]) {
    const recipe = G.campaignRecipe(n);
    const whole = text(G.makeLevel(`c/${n}`, recipe));
    assert.equal(text(G.makeLevel(`c/${n}`, recipe)), whole);
    const search = G.levelSearch(`c/${n}`, recipe);
    let step = search.next();
    let pauses = 0;
    while (!step.done) {
      pauses++;
      step = search.next();
    }
    assert.equal(text(step.value), whole, `level ${n} after ${pauses} pauses`);
  }
});

test('recipes stay within what a phone screen and the solver can handle', () => {
  for (let n = 5; n <= 6000; n += n < 300 ? 1 : 37) {
    const r = G.campaignRecipe(n);
    assert.ok(r.w >= 5 && r.w <= 7 && r.h >= 5 && r.h <= 9, `size of level ${n}`);
    assert.ok(r.blocks >= 3 && r.blocks <= 9, `blocks of level ${n}`);
    assert.ok(r.luckMin >= 0 && r.luckMin < r.luckMax && r.luckMax <= 1, `luck band of level ${n}`);
  }
  for (let d = 1; d <= 60; d++) {
    const r = G.dailyRecipe(d, d % 7);
    assert.ok(r.w <= 7 && r.h <= 9 && r.blocks <= 9);
  }
});

test('every shipped level is well formed and can be solved', () => {
  assert.equal(CAMPAIGN.length, 2000);
  assert.equal(DAILY.length, 2200);
  assert.deepEqual(CAMPAIGN.slice(0, G.OPENING.length), G.OPENING);
  for (const [name, table] of [['campaign', CAMPAIGN], ['daily', DAILY]]) {
    table.forEach((entry, i) => {
      const level = E.parseLevel(entry);
      assert.equal(text(level), entry, `${name} ${i + 1} is in canonical form`);
      assert.ok(level.w <= 7 && level.h <= 9, `${name} ${i + 1} fits the screen`);
      assert.ok(level.blocks.length >= 1 && level.blocks.length <= 9, `${name} ${i + 1} block count`);
      assert.ok(E.createSolver(level).solvable(E.startPosition(level)), `${name} ${i + 1} is solvable: ${entry}`);
    });
  }
  assert.equal(new Set(CAMPAIGN).size, CAMPAIGN.length, 'no campaign level is repeated');
  assert.equal(new Set(DAILY).size, DAILY.length, 'no Daily is repeated');
});

test('no shipped level shows an arrow that can never claim anything or a number that limits nothing', () => {
  const check = (name, entry, i) => {
    const level = E.parseLevel(entry);
    const empty = E.startPosition(level).owner;
    level.blocks.forEach((block, b) => {
      const unlimited = { ...level, blocks: level.blocks.map((x, k) => (k === b ? { ...x, len: 0 } : x)) };
      const sent = E.arms(unlimited, empty, b);
      if (block.dirs !== ALL) {
        for (const arm of sent) assert.ok(arm.cells.length > 0, `${name} ${i + 1}: block ${b} has a dead arrow in ${entry}`);
      }
      if (block.len) {
        const longest = Math.max(...sent.map((arm) => arm.cells.length));
        assert.ok(block.len < longest, `${name} ${i + 1}: the number on block ${b} limits nothing in ${entry}`);
      }
    });
  };
  CAMPAIGN.slice(G.OPENING.length).forEach((entry, i) => check('campaign', entry, i + G.OPENING.length));
  DAILY.forEach((entry, i) => check('daily', entry, i));
});

test('the shipped tables are exactly what the generator produces', () => {
  // A spread is enough to catch the generator and the tables drifting apart.
  for (const n of [5, 6, 11, 15, 16, 23, 40, 41, 77, 80, 81, 150, 151, 500, 1000, 1500, 2000]) {
    assert.equal(text(G.makeLevel(`c/${n}`, G.campaignRecipe(n))), CAMPAIGN[n - 1], `campaign ${n}`);
  }
  for (const n of [1, 2, 3, 9, 30, 365, 1200, 2200]) {
    assert.equal(text(G.makeLevel(`d/${n}`, G.dailyRecipe(n, weekdayOf(n)))), DAILY[n - 1], `daily ${n}`);
  }
});

test('the game reads the right table entry for a level number and for a date', () => {
  for (const n of [1, 4, 5, 123, 999, 2000]) assert.equal(text(L.campaignLevel(n)), CAMPAIGN[n - 1], `campaign ${n}`);
  for (const days of [0, 1, 2, 6, 7, 30, 364, 365, 1000, 2199]) {
    assert.equal(text(L.dailyLevel(dayKey(days))), DAILY[days], `daily for day ${days}`);
  }
});

test('beyond the tables the game builds the same level the build script would', () => {
  const n = CAMPAIGN.length + 1;
  const made = text(G.makeLevel(`c/${n}`, G.campaignRecipe(n)));
  assert.equal(text(L.campaignLevel(n)), made);
  assert.equal(text(L.campaignLevel(n)), made, 'and the same again from the cache');

  // A date past the Daily table: the puzzle follows that date's own weekday.
  const number = DAILY.length + 3;
  const key = dayKey(number - 1);
  const [y, m, d] = key.split('-').map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  assert.equal(weekday, weekdayOf(number), 'the UTC arithmetic agrees with the local calendar');
  assert.equal(text(L.dailyLevel(key)), text(G.makeLevel(`d/${number}`, G.dailyRecipe(number, weekday))));

  // A clock set before launch day still gets a puzzle.
  assert.ok(E.createSolver(L.dailyLevel('2020-01-01')).solvable(E.startPosition(L.dailyLevel('2020-01-01'))));
});

test('levels built on the device land inside the difficulty band their recipe asks for', () => {
  for (const n of [2001, 2003, 2010, 2047, 2500]) {
    const recipe = G.campaignRecipe(n);
    const m = E.measure(G.makeLevel(`c/${n}`, recipe));
    assert.ok(m.solvable);
    assert.ok(m.luck >= recipe.luckMin && m.luck <= recipe.luckMax, `level ${n}: luck ${m.luck} not in ${recipe.luckMin}..${recipe.luckMax}`);
  }
});

test('difficulty rises through the campaign, and only the first two levels cannot be got wrong', () => {
  const luck = (n) => E.measure(E.parseLevel(CAMPAIGN[n - 1])).luck;
  const mean = (from, to) => {
    let sum = 0;
    for (let n = from; n <= to; n++) sum += luck(n);
    return sum / (to - from + 1);
  };
  const early = mean(5, 14);
  const mid = mean(41, 79);
  const late = mean(150, 250);
  assert.ok(early > mid && mid > late, `luck should fall: ${early.toFixed(3)} > ${mid.toFixed(3)} > ${late.toFixed(3)}`);
  assert.equal(luck(1), 1);
  assert.equal(luck(2), 1);
  for (let n = 3; n <= 300; n++) assert.ok(luck(n) < 1, `level ${n} can be got wrong`);
  for (let n = 305; n <= CAMPAIGN.length; n += 5) assert.ok(luck(n) < 1, `level ${n} can be got wrong`);
  for (let i = 0; i < DAILY.length; i += 4) assert.ok(E.measure(E.parseLevel(DAILY[i])).luck < 0.5, `daily ${i + 1} is a real puzzle`);
});

test('the Daily is gentler on Mondays than at the weekend', () => {
  const byDay = Array.from({ length: 7 }, () => []);
  for (let n = 1; n <= 700; n++) byDay[(weekdayOf(n) + 6) % 7].push(E.measure(E.parseLevel(DAILY[n - 1])).luck);
  const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  const [mon, , , , , , sun] = byDay.map(mean);
  assert.ok(mon > 2 * sun, `Monday ${mon.toFixed(3)} should be much easier than Sunday ${sun.toFixed(3)}`);
});

test('each new kind of block is introduced in the level that says so', () => {
  const kinds = (n) => L.featuresOf(E.parseLevel(CAMPAIGN[n - 1]));
  for (let n = 1; n < G.INTRO.lines; n++) {
    const f = kinds(n);
    assert.ok(!f.lines && !f.bends && !f.short, `level ${n} should be plain`);
  }
  assert.ok(kinds(G.INTRO.lines).lines);
  assert.ok(kinds(G.INTRO.bends).bends || kinds(G.INTRO.bends).lines);
  assert.ok(kinds(G.INTRO.short).short, 'the level that introduces numbers has a number that matters');
  for (let n = G.INTRO.lines; n < G.INTRO.bends; n++) assert.ok(!kinds(n).bends, `no bends before ${G.INTRO.bends}`);
  for (let n = 1; n < G.INTRO.short; n++) assert.ok(!kinds(n).short, `no numbers before ${G.INTRO.short}`);
});
