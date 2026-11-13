// End-to-end tests: the real game in a real (headless) browser at phone size.
// Run with `npm run test:e2e`. Needs Playwright's Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { webDir } from '../test/game/_web.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

let server;
let browser;
let base;

before(async () => {
  server = http.createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    try {
      const data = await readFile(join(webDir, normalize(path)));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

/** A fresh phone with nothing saved. Fails the test on any page error. */
async function phone(t, { width = 390, height = 844, query = '', save = null, fixedTime = null, prepare = null, expectErrors = null } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    hasTouch: true,
    isMobile: true,
    reducedMotion: 'reduce',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  // `save` is written to storage before the game starts, as if left by an earlier visit.
  if (save) await context.addInitScript((text) => localStorage.setItem('save.v1', text), JSON.stringify(save));
  const page = await context.newPage();
  // A fixed clock: Date reads this time, while timers keep running normally.
  if (fixedTime) await page.clock.setFixedTime(fixedTime);
  if (prepare) await prepare(page, context);
  const problems = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
  });
  t.after(async () => {
    await context.close();
    // `expectErrors` lists errors a test provokes on purpose.
    const unexpected = expectErrors ? problems.filter((text) => !expectErrors.test(text)) : problems;
    assert.deepEqual(unexpected, [], 'the page reported errors');
  });
  await page.goto(base + query);
  await page.waitForSelector('.screen');
  return page;
}

const title = (page) => page.locator('.title').innerText();
const slips = (page) => page.locator('.hud .stat b').nth(1).innerText();
const litStars = (page) => page.locator('.meter .star.on').count();
const hearts = (page) => page.locator('.meter .heart.on').count();
const tapBlock = (page, b) => page.locator(`.block[data-b="${b}"]`).click();
/** The result sheet while it is open (a closing sheet lingers in the page for a moment). */
const OPEN_RESULT = '.sheet-wrap:not(.out) .sheet.result';
const sheetButton = (page, text) => page.locator('.sheet-wrap:not(.out) .sheet button', { hasText: text });

/**
 * Ask the game's own solver, inside the page, which blocks are safe or unsafe right now.
 * The position is rebuilt from the saved attempt, which is written a moment after each tap,
 * so this waits until the save matches what is on screen.
 */
async function advice(page, mode) {
  for (let attempt = 0; ; attempt++) {
    const answer = await adviceOnce(page, mode);
    if (answer.settled || attempt >= 25) return answer;
    await page.waitForTimeout(40);
  }
}

function adviceOnce(page, mode) {
  return page.evaluate(async (which) => {
    const [{ createSolver, startPosition, play }, levels, dates] = await Promise.all([
      import('./js/engine.js'),
      import('./js/levels.js'),
      import('./js/dates.js'),
    ]);
    const store = JSON.parse(localStorage.getItem('save.v1') || '{}');
    const number = Number(document.querySelector('.title').textContent.replace(/\D+/g, ''));
    const level = which === 'daily' ? levels.dailyLevel(dates.dateKey()) : levels.campaignLevel(number);
    const solver = createSolver(level);
    // Rebuild the position from what is on screen: blocks marked done, in the order saved.
    let pos = startPosition(level);
    const saved = (store.resume && store.resume[which === 'daily' ? 'daily' : 'campaign']) || null;
    for (const b of saved ? saved.taps : []) {
      if (pos.done & (1 << b)) continue;
      const next = play(level, pos, b);
      if (next.claimed === pos.claimed || solver.solvable(next)) pos = next;
    }
    const safe = solver.safeBlocks(pos);
    const unsafe = [];
    for (let b = 0; b < level.blocks.length; b++) {
      if (pos.done & (1 << b) || safe.includes(b)) continue;
      if (play(level, pos, b).claimed > pos.claimed) unsafe.push(b);
    }
    let done = 0;
    for (let b = 0; b < level.blocks.length; b++) if (pos.done & (1 << b)) done++;
    const settled = done === document.querySelectorAll('.block.done').length;
    return { safe, unsafe, blocks: level.blocks.length, settled };
  }, mode);
}

/** Finish the level on screen without a slip. */
async function solve(page, mode = 'campaign') {
  for (let i = 0; i < 12; i++) {
    if (await page.locator(OPEN_RESULT).count()) return;
    // Board full (every square is a block or claimed): the result sheet is on its way.
    const full = await page.evaluate(
      () => document.querySelectorAll('.sq').length === document.querySelectorAll('.claim:not(.ghosted)').length + document.querySelectorAll('.block').length,
    );
    if (full) break;
    const { safe } = await advice(page, mode);
    if (!safe.length) break;
    await tapBlock(page, safe[0]);
    await page.waitForTimeout(250);
  }
  await page.waitForSelector(OPEN_RESULT);
}

test('a new player goes straight into level 1 and can play through the tutorial', async (t) => {
  const page = await phone(t);
  assert.equal(await title(page), 'Level 1');
  assert.equal(await page.locator('.coach').innerText(), 'Tap the block');
  await tapBlock(page, 0);
  await page.waitForSelector('.sheet.result');
  assert.equal(await page.locator('.result-title').innerText(), 'Flawless!');
  assert.equal(await page.locator('.result-detail').innerText(), '1 block · no slips');
  assert.equal(await page.locator('.result-stars .star.on').count(), 3);
  await sheetButton(page, 'Next level').click();
  await page.waitForFunction(() => document.querySelector('.title').textContent === 'Level 2');

  await solve(page);
  await sheetButton(page, 'Next level').click();
  await page.waitForFunction(() => document.querySelector('.title').textContent === 'Level 3');

  // Level 3: the wrong block first is a slip. The board is put back and a star is lost.
  const { unsafe, safe } = await advice(page);
  assert.equal(unsafe.length, 1);
  await tapBlock(page, unsafe[0]);
  await page.waitForSelector('.cross');
  assert.ok((await page.locator('.cross').count()) >= 1, 'the squares that would be stranded are marked');
  await page.waitForFunction(() => !document.querySelector('.cross') && !document.querySelector('.claim.ghosted'));
  assert.equal(await slips(page), '1');
  assert.equal(await litStars(page), 2);
  assert.equal(await page.locator('.claim').count(), 0, 'the slip left nothing behind');
  assert.match(await page.locator('.coach').innerText(), /Try another order/);
  await page.waitForTimeout(900);
  await tapBlock(page, safe[0]);
  await solve(page);
  assert.equal(await page.locator('.result-title').innerText(), 'Solved!');
  assert.equal(await page.locator('.result-stars .star.on').count(), 2);
  assert.equal(await sheetButton(page, 'Try for 3 stars').count(), 1);

  // Home shows the progress.
  await sheetButton(page, 'Home').click();
  await page.waitForSelector('.screen.home');
  assert.equal(await page.locator('.play .big').innerText(), 'Level 4');
  assert.equal(await page.locator('.play .small').innerText(), '8 stars collected');
});

test('a level in progress survives the app being closed', async (t) => {
  const page = await phone(t, { query: '?level=30' });
  const first = await advice(page);
  await tapBlock(page, first.unsafe[0]);
  await page.waitForTimeout(1200);
  await tapBlock(page, first.safe[0]);
  await page.waitForTimeout(400);
  const claimed = await page.locator('.claim').count();
  assert.ok(claimed > 0);
  await page.reload();
  await page.waitForSelector('.board');
  assert.equal(await title(page), 'Level 30');
  assert.equal(await slips(page), '1');
  assert.equal(await page.locator('.claim').count(), claimed);
  assert.equal(await page.locator('.block.done').count(), 1);
  // Restart wipes the attempt.
  await page.locator('.tool', { hasText: 'Restart' }).click();
  assert.equal(await slips(page), '0');
  assert.equal(await page.locator('.claim').count(), 0);
});

test('a hint costs a token, points at a safe block, and is free to ask for again', async (t) => {
  const page = await phone(t, { query: '?level=30' });
  assert.equal(await page.locator('.hint-btn .badge').innerText(), '3');
  await page.locator('.hint-btn').click();
  const hinted = await page.locator('.block.hinted').getAttribute('data-b');
  assert.ok((await advice(page)).safe.includes(Number(hinted)));
  assert.equal(await page.locator('.hint-btn .badge').innerText(), '2');
  await page.locator('.hint-btn').click();
  assert.equal(await page.locator('.hint-btn .badge').innerText(), '2', 'asking again about the same position is free');
  await page.locator('.block.hinted').click();
  await page.waitForTimeout(300);
  assert.equal(await slips(page), '0');
});

test('holding a block previews its reach without playing it', async (t) => {
  const page = await phone(t, { query: '?level=4' });
  const box = await page.locator('.block[data-b="1"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForSelector('.peekcell');
  assert.ok((await page.locator('.peekcell').count()) > 0);
  await page.mouse.up();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.peekcell').count(), 0);
  assert.equal(await page.locator('.block.done').count(), 0, 'a peek is not a tap');
  assert.equal(await page.locator('.claim').count(), 0);
});

test('the Daily: three hearts, one more for a video, then a result to share', async (t) => {
  const page = await phone(t, { query: '?daily&ads=mock&fast' });
  assert.match(await title(page), /^Daily #\d+$/);
  assert.equal(await hearts(page), 3);
  assert.equal(await page.locator('.mock-banner').count(), 0, 'no banner on the Daily');
  const { unsafe } = await advice(page, 'daily');
  assert.ok(unsafe.length > 0, 'a Daily always has a wrong first tap');
  for (let i = 0; i < 3; i++) {
    await tapBlock(page, unsafe[0]);
    await page.waitForTimeout(1300);
  }
  await page.waitForSelector('.sheet.result');
  assert.equal(await page.locator('.result-title').innerText(), 'Out of hearts');

  // Closing the app here must not lose the offer or grant a free retry.
  await page.reload();
  await page.waitForSelector('.sheet.result');
  assert.equal(await page.locator('.result-title').innerText(), 'Out of hearts');

  await sheetButton(page, 'Watch a video for a heart').click();
  await page.waitForSelector('.mock-ad');
  await page.locator('.mock-ad-close:not([disabled])').click();
  await page.waitForFunction(() => !document.querySelector('.sheet-wrap:not(.out) .sheet.result'));
  assert.equal(await hearts(page), 1);
  assert.equal(await page.locator('.meter .heart').count(), 4);

  await solve(page, 'daily');
  assert.equal(await page.locator('.result-title').innerText(), 'Daily solved!');
  const { blocks } = await advice(page, 'daily');
  assert.equal(await page.locator('.story .miss').count(), 3);
  assert.ok((await page.locator('.story .hit').count()) >= 1 && (await page.locator('.story .hit').count()) <= blocks);
  assert.match(await page.locator('.streak').innerText(), /1-day streak/);
  assert.match(await page.locator('.countdown').innerText(), /^Next puzzle in /);
  assert.deepEqual(await page.evaluate(() => window.__mockAds.log), ['rewarded'], 'no full-screen advert around the Daily');

  await sheetButton(page, 'Share').click();
  await page.waitForSelector('.toast');
  const shared = await page.evaluate(() => navigator.clipboard.readText());
  const lines = shared.split('\n');
  assert.match(lines[0], /^First Come #\d+ ⭐$/);
  assert.match(lines[1], /^(🟩|🟥)+$/u);
  assert.equal(lines[2], 'Solved with 3 slips');
  assert.match(lines[lines.length - 1], /^https:\/\//);

  // Today's Daily cannot be played twice: coming back shows the result again.
  await sheetButton(page, 'Home').click();
  await page.waitForSelector('.screen.home');
  assert.match(await page.locator('.daily .small').innerText(), /^★ · next in /);
  assert.equal(await page.locator('.streak-pill').innerText(), '1');
  await page.locator('.daily').click();
  await page.waitForSelector('.sheet.result');
  assert.equal(await page.locator('.result-title').innerText(), 'Solved today');
});

test('giving up the Daily records a loss and shares it honestly', async (t) => {
  const page = await phone(t, { query: '?daily' });
  const { unsafe } = await advice(page, 'daily');
  for (let i = 0; i < 3; i++) {
    await tapBlock(page, unsafe[0]);
    await page.waitForTimeout(1300);
  }
  await page.waitForSelector('.sheet.result');
  // On the web there are no adverts, so the extra heart is simply offered.
  assert.equal(await sheetButton(page, 'One more heart').count(), 1);
  await sheetButton(page, 'Give up for today').click();
  await page.waitForFunction(() => document.querySelector('.result-title')?.textContent === 'Not today');
  await sheetButton(page, 'Share').click();
  await page.waitForSelector('.toast');
  const shared = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(shared, /^First Come #\d+ 💔\n🟥🟥🟥\nOut of hearts\nhttps:/u);
  await sheetButton(page, 'Home').click();
  assert.match(await page.locator('.daily .small').innerText(), /^Out of hearts · next in /);
  assert.equal(await page.locator('.streak-pill').isVisible(), false);
});

test('adverts: a banner while playing, a full-screen advert only between levels, and none after Remove Ads', async (t) => {
  const page = await phone(t, { query: '?ads=mock&fast&debug' });
  await page.waitForSelector('.mock-banner');
  // Nothing the player needs may sit under the banner.
  const banner = await page.locator('.mock-banner').boundingBox();
  const tools = await page.locator('.tools').boundingBox();
  assert.ok(tools.y + tools.height <= banner.y + 0.5, 'the buttons sit above the banner');

  const adLog = () => page.evaluate(() => window.__mockAds.log);
  await solve(page);
  await sheetButton(page, 'Next level').click();
  await page.waitForFunction(() => document.querySelector('.title').textContent === 'Level 2');
  assert.deepEqual(await adLog(), [], 'no advert after the first level');

  await solve(page);
  // The result sheet clears the banner too.
  const sheet = await page.locator('.sheet').boundingBox();
  assert.ok(sheet.y + sheet.height <= banner.y + 0.5, 'the result sheet sits above the banner');
  await sheetButton(page, 'Next level').click();
  await page.waitForSelector('.mock-ad');
  assert.deepEqual(await adLog(), ['interstitial']);
  assert.equal(await title(page), 'Level 2', 'the next level waits for the advert to close');
  await page.locator('.mock-ad-close:not([disabled])').click();
  await page.waitForFunction(() => document.querySelector('.title').textContent === 'Level 3');

  // The banner belongs to the play screen only.
  await page.locator('.topbar .icon-btn').first().click();
  await page.waitForSelector('.screen.home');
  assert.equal(await page.locator('.mock-banner').count(), 0, 'no banner on the home screen');
  await page.locator('.play').click();
  await page.waitForSelector('.mock-banner');

  // Out of hint tokens, the hint button offers a video instead.
  await page.evaluate(() => {
    window.__app.store.state.hints = 0;
    window.__app.refresh();
  });
  assert.equal(await page.locator('.hint-btn .badge.video').count(), 1);
  await page.locator('.hint-btn').click();
  await page.waitForSelector('.mock-ad');
  await page.locator('.mock-ad-close:not([disabled])').click();
  await page.waitForSelector('.block.hinted');

  // Remove Ads.
  await page.locator('.topbar .icon-btn').nth(1).click();
  await page.locator('.sheet .row', { hasText: 'Remove ads' }).click();
  await page.locator('.sheet .primary', { hasText: 'Remove ads' }).click();
  await page.waitForFunction(() => !document.querySelector('.mock-banner'));
  const save = await page.evaluate(() => window.__app.store.state);
  assert.equal(save.removeAds, true);
  assert.equal(save.hints, 10, 'bonus hints came with the purchase');
});

test('a quick or a slow tap plays the block; only a long press is a peek', async (t) => {
  const page = await phone(t);
  const box = await page.locator('.block[data-b="0"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(280);
  await page.mouse.up();
  await page.waitForSelector(OPEN_RESULT);
  assert.equal(await page.locator('.result-title').innerText(), 'Flawless!');
});

test('a hint that was paid for survives a slip and a restart of the app', async (t) => {
  const page = await phone(t, { query: '?level=30' });
  await page.locator('.hint-btn').click();
  const hinted = await page.locator('.block.hinted').getAttribute('data-b');
  assert.equal(await page.locator('.hint-btn .badge').innerText(), '2');

  // A slip puts the board back exactly as it was, so the hint is still good.
  const { unsafe } = await advice(page);
  await tapBlock(page, unsafe[0]);
  await page.waitForSelector('.cross');
  await page.waitForFunction(() => !document.querySelector('.cross') && !document.querySelector('.claim.ghosted'));
  await page.waitForSelector('.block.hinted');
  assert.equal(await page.locator('.block.hinted').getAttribute('data-b'), hinted);
  assert.equal(await page.locator('.hint-btn .badge').innerText(), '2');

  // Closing and reopening the app does not lose it either.
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForSelector('.block.hinted');
  assert.equal(await page.locator('.block.hinted').getAttribute('data-b'), hinted);
  await page.locator('.hint-btn').click();
  assert.equal(await page.locator('.hint-btn .badge').innerText(), '2', 'asking again is free');

  // Playing a block moves on: the next hint is a new one.
  await page.locator('.block.hinted').click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.block.hinted').count(), 0);
  await page.locator('.hint-btn').click();
  assert.equal(await page.locator('.hint-btn .badge').innerText(), '1');
});

test('a tap made while a slip is being shown is kept, not thrown away', async (t) => {
  const page = await phone(t, { query: '?level=30' });
  const { safe, unsafe } = await advice(page);
  await tapBlock(page, unsafe[0]);
  await page.waitForSelector('.claim.ghosted');
  await tapBlock(page, safe[0]);
  await page.waitForFunction(() => !document.querySelector('.claim.ghosted'));
  await page.waitForSelector(`.block.done[data-b="${safe[0]}"]`);
  assert.equal(await slips(page), '1');
});

test('the streak offer appears at launch, before any video has had time to load', async (t) => {
  const key = (daysAgo) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const save = { level: 12, stats: { solved: 11 }, daily: { streak: 5, best: 5, lastSolved: key(2) } };
  const page = await phone(t, { query: '?ads=mock&fast&debug', save });
  await page.waitForSelector('.sheet');
  assert.equal(await page.locator('.sheet-head h2').innerText(), 'Save your streak?');
  assert.match(await page.locator('.sheet .shop p').first().innerText(), /5-day streak/);
  await page.locator('.sheet .primary').click();
  await page.waitForSelector('.mock-ad');
  await page.locator('.mock-ad-close:not([disabled])').click();
  await page.waitForFunction(() => !document.querySelector('.sheet-wrap:not(.out)'));
  const daily = await page.evaluate(() => window.__app.store.state.daily);
  assert.equal(daily.lastSolved, key(1), 'the missed day is forgiven');
  assert.equal(daily.streak, 5);
  assert.equal(await page.locator('.streak-pill').innerText(), '5');
  // It is offered once: coming back to Home does not ask again.
  await page.locator('.play').click();
  await page.locator('.topbar .icon-btn').first().click();
  await page.waitForSelector('.screen.home');
  assert.equal(await page.locator('.sheet-wrap:not(.out)').count(), 0);
});

test('a second copy of the game in another tab cannot wipe newer progress', async (t) => {
  const older = await phone(t);
  const newer = await older.context().newPage();
  await newer.goto(base);
  await newer.waitForSelector('.board');
  await tapBlock(newer, 0);
  await newer.waitForSelector(OPEN_RESULT);
  await newer.waitForTimeout(300);
  // The older tab notices and shows the newer progress...
  await older.waitForSelector('.screen.home');
  assert.equal(await older.locator('.play .big').innerText(), 'Level 2');
  // ...and closing it does not write its stale copy back.
  await older.close();
  const save = await newer.evaluate(() => JSON.parse(localStorage.getItem('save.v1')));
  assert.equal(save.level, 2);
  assert.equal(save.stats.solved, 1);
});

test('a damaged save cannot stop the game from starting', async (t) => {
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const save = {
    level: 3,
    stats: { solved: 2 },
    daily: { streak: 4, lastSolved: 12345, history: { [key]: { won: true, stars: 1e9, extra: 1e9, taps: 'zz' } } },
    resume: { campaign: { id: 3, taps: [null, true, 1.5, 0] }, daily: { id: key, taps: 'oops' } },
  };
  const page = await phone(t, { save });
  await page.waitForSelector('.screen.home');
  assert.equal(await page.locator('.play .big').innerText(), 'Level 3');
  await page.locator('.play').click();
  await page.waitForSelector('.board');
  assert.equal(await title(page), 'Level 3');
  await page.locator('.topbar .icon-btn').first().click();
  await page.locator('.daily').click();
  await page.waitForSelector('.board');
  assert.ok((await page.locator('.meter .heart').count()) <= 4);
});

test('a Daily left open past midnight hands over to the new puzzle', async (t) => {
  const evening = new Date(2027, 2, 9, 23, 59, 40);
  const morning = new Date(2027, 2, 10, 8, 0, 0);
  const page = await phone(t, { query: '?daily', fixedTime: evening });
  const first = await title(page);

  // Untouched and brought back to the front the next day: it becomes that day's puzzle.
  await page.clock.setFixedTime(morning);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction((was) => document.querySelector('.title').textContent !== was, first);
  const second = await title(page);
  assert.equal(Number(second.replace(/\D+/g, '')), Number(first.replace(/\D+/g, '')) + 1);

  // Finished, then left on the result sheet overnight: the countdown gives way to the new puzzle.
  await page.clock.setFixedTime(new Date(2027, 2, 10, 23, 59, 50));
  await solve(page, 'daily');
  assert.match(await page.locator('.countdown').innerText(), /^Next puzzle in 0m \d\ds$/);
  await page.clock.setFixedTime(new Date(2027, 2, 11, 7, 30, 0));
  await page.locator('.sheet button', { hasText: 'Play today’s puzzle' }).click();
  await page.waitForFunction((was) => document.querySelector('.title').textContent !== was, second);
  assert.equal(Number((await title(page)).replace(/\D+/g, '')), Number(second.replace(/\D+/g, '')) + 1);
  assert.equal(await hearts(page), 3);
});

/** Lose all three hearts of today's Daily. */
async function loseThreeHearts(page) {
  const { unsafe } = await advice(page, 'daily');
  for (let i = 0; i < 3; i++) {
    await tapBlock(page, unsafe[0]);
    await page.waitForTimeout(1300);
  }
  await page.waitForSelector(OPEN_RESULT);
  return unsafe[0];
}
const useUpHints = (page) =>
  page.evaluate(() => {
    window.__app.store.state.hints = 0;
    window.__app.refresh();
  });

test('a video that is closed early pays nothing: no hint, no heart, no saved streak', async (t) => {
  const page = await phone(t, { query: '?level=30&ads=mock&fast&debug' });
  await useUpHints(page);
  await page.locator('.hint-btn').click();
  await page.waitForSelector('.mock-ad');
  await page.locator('.mock-ad-skip').click();
  await page.waitForSelector('.toast');
  assert.match(await page.locator('.toast').innerText(), /No reward this time/);
  assert.equal(await page.locator('.block.hinted').count(), 0);
  assert.equal(await page.evaluate(() => window.__app.store.state.stats.hintsUsed), 0);
  assert.equal(await page.locator('.ad-cover').count(), 0, 'the cover is gone once the advert has closed');

  const daily = await phone(t, { query: '?daily&ads=mock&fast&debug' });
  await loseThreeHearts(daily);
  await sheetButton(daily, 'Watch a video for a heart').click();
  await daily.waitForSelector('.mock-ad');
  await daily.locator('.mock-ad-skip').click();
  await daily.waitForSelector('.toast');
  assert.equal(await daily.locator('.result-title').innerText(), 'Out of hearts', 'the offer is still there');
  assert.equal(await hearts(daily), 0);
});

test('the extra heart comes once a day: losing it too ends the puzzle', async (t) => {
  const page = await phone(t, { query: '?daily&ads=mock&fast' });
  const wrong = await loseThreeHearts(page);
  await sheetButton(page, 'Watch a video for a heart').click();
  await page.waitForSelector('.mock-ad');
  await page.locator('.mock-ad-close:not([disabled])').click();
  await page.waitForFunction(() => !document.querySelector('.sheet-wrap:not(.out) .sheet.result'));
  await tapBlock(page, wrong);
  await page.waitForFunction(() => document.querySelector('.sheet-wrap:not(.out) .result-title')?.textContent === 'Not today');
  assert.equal(await sheetButton(page, 'Watch a video for a heart').count(), 0, 'no second offer');
  assert.deepEqual(await page.evaluate(() => window.__mockAds.log), ['rewarded']);
});

test('an advert that never comes back does not trap the player', async (t) => {
  const page = await phone(t, { query: '?daily&ads=mock&fast&hang' });
  await loseThreeHearts(page);
  await sheetButton(page, 'Watch a video for a heart').click();
  // The screen is covered while the advert is awaited, so nothing else can be tapped...
  await page.waitForSelector('.ad-cover');
  assert.equal(await page.locator('.ad-cover button').count(), 0);
  // ...and when it takes too long there is a way back.
  await page.locator('.ad-cover button', { hasText: 'Back to the game' }).click();
  await page.waitForFunction(() => !document.querySelector('.ad-cover'));
  assert.equal(await page.locator('.result-title').innerText(), 'Out of hearts');
  await sheetButton(page, 'Give up for today').click();
  await page.waitForFunction(() => document.querySelector('.sheet-wrap:not(.out) .result-title')?.textContent === 'Not today');

  // The same in a level: after backing out, the board is playable and Hint can be asked again.
  const level = await phone(t, { query: '?level=30&ads=mock&fast&hang&debug' });
  await useUpHints(level);
  await level.locator('.hint-btn').click();
  await level.locator('.ad-cover button', { hasText: 'Back to the game' }).click();
  await level.waitForFunction(() => !document.querySelector('.ad-cover'));
  const { safe } = await advice(level);
  await tapBlock(level, safe[0]);
  await level.waitForSelector(`.block.done[data-b="${safe[0]}"]`);
  await level.locator('.hint-btn').click();
  await level.waitForSelector('.ad-cover');
});

test('no full-screen advert around the Daily, even when one is due', async (t) => {
  const save = { level: 30, stats: { solved: 29 }, ads: { levelsSince: 9 } };
  const page = await phone(t, { query: '?daily&ads=mock&fast&debug', save });
  await solve(page, 'daily');
  await sheetButton(page, 'Home').click();
  await page.waitForSelector('.screen.home');
  assert.deepEqual(await page.evaluate(() => window.__mockAds.log), [], 'nothing was shown around the Daily');
  // An advert really was due: the next campaign level brings it.
  await page.locator('.play').click();
  await page.waitForSelector('.board');
  await solve(page);
  await sheetButton(page, 'Next level').click();
  // It is announced first, then shown; the next level waits for it.
  await page.waitForSelector('.ad-cover');
  await page.waitForSelector('.mock-ad');
  assert.deepEqual(await page.evaluate(() => window.__mockAds.log), ['interstitial']);
  await page.locator('.mock-ad-close:not([disabled])').click();
  await page.waitForFunction(() => document.querySelector('.title').textContent === 'Level 31');
  assert.equal(await page.locator('.ad-cover').count(), 0);
});

test('inside the app, a bridge that fails to load never makes rewards free', async (t) => {
  const page = await phone(t, {
    query: '?level=30&debug',
    expectErrors: /Native bridge failed|Failed to load resource|native-bridge/,
    prepare: async (pg, context) => {
      await context.addInitScript(() => {
        window.Capacitor = { isNativePlatform: () => true };
      });
      await pg.route('**/vendor/native-bridge.js', (route) => route.abort());
    },
  });
  await useUpHints(page);
  assert.equal(await page.locator('.hint-btn .badge.video').count(), 1, 'a video is asked for, not handed out');
  await page.locator('.hint-btn').click();
  await page.waitForSelector('.toast');
  assert.match(await page.locator('.toast').innerText(), /No video is available/);
  assert.equal(await page.locator('.block.hinted').count(), 0);
});

test('a hint bought before the first tap is still there after Restart', async (t) => {
  const page = await phone(t, { query: '?level=30' });
  await page.locator('.hint-btn').click();
  const hinted = await page.locator('.block.hinted').getAttribute('data-b');
  const { unsafe } = await advice(page);
  await tapBlock(page, unsafe[0]);
  await page.waitForSelector('.cross');
  await page.waitForFunction(() => !document.querySelector('.cross') && !document.querySelector('.claim.ghosted'));
  await page.locator('.tool', { hasText: 'Restart' }).click();
  assert.equal(await slips(page), '0');
  assert.equal(await page.locator('.block.hinted').getAttribute('data-b'), hinted);
  assert.equal(await page.locator('.hint-btn .badge').innerText(), '2', 'and it was not charged for again');
});

test('the streak offer: made on returning to the app, kept until answered, and checked again when pressed', async (t) => {
  const streak = { streak: 5, best: 5, lastSolved: '2027-03-08' };
  const save = { level: 12, stats: { solved: 11 }, daily: streak };
  const at = (day, hour = 10) => new Date(2027, 2, day, hour, 0, 0);
  const lastSolved = (page) => page.evaluate(() => window.__app.store.state.daily.lastSolved);
  const comeBack = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const openSheets = (page) => page.locator('.sheet-wrap:not(.out)').count();

  // Yesterday was played: nothing to offer. The app is then left open and brought back two days on.
  const page = await phone(t, { query: '?ads=mock&fast&debug', save, fixedTime: at(9) });
  await page.waitForSelector('.screen.home');
  assert.equal(await openSheets(page), 0);
  await page.clock.setFixedTime(at(10));
  await comeBack(page);
  await page.waitForSelector('.sheet');
  assert.equal(await page.locator('.sheet-head h2').innerText(), 'Save your streak?');

  // A stray tap beside the sheet does not throw the chance away.
  await page.mouse.click(195, 60);
  await page.waitForTimeout(300);
  assert.equal(await openSheets(page), 1);
  assert.equal(await page.evaluate(() => window.__app.store.state.daily.repairOffered), null);

  // Left open for days, the button no longer works, and says so.
  await page.clock.setFixedTime(at(13));
  await page.locator('.sheet .primary').click();
  await page.waitForFunction(() => !document.querySelector('.sheet-wrap:not(.out)'));
  assert.equal(await lastSolved(page), '2027-03-08', 'nothing was changed');
  assert.deepEqual(await page.evaluate(() => window.__mockAds.log), [], 'and no video was spent');

  // Declining is an answer: it is not asked again that day.
  const second = await phone(t, { query: '?ads=mock&fast&debug', save, fixedTime: at(10) });
  await second.waitForSelector('.sheet');
  await second.locator('.sheet button', { hasText: 'No thanks' }).click();
  await second.waitForFunction(() => !document.querySelector('.sheet-wrap:not(.out)'));
  await comeBack(second);
  await second.waitForTimeout(300);
  assert.equal(await openSheets(second), 0);

  // Going straight to the Daily while a streak can still be saved asks first, then carries on.
  const third = await phone(t, { query: '?daily&ads=mock&fast&debug', save, fixedTime: at(10) });
  await third.waitForSelector('.sheet');
  assert.equal(await third.locator('.sheet-head h2').innerText(), 'Save your streak?');
  await third.locator('.sheet .primary').click();
  await third.waitForSelector('.mock-ad');
  await third.locator('.mock-ad-close:not([disabled])').click();
  await third.waitForSelector('.board');
  assert.match(await title(third), /^Daily #/);
  assert.equal(await lastSolved(third), '2027-03-09', 'the missed day is forgiven');
  assert.equal(await third.evaluate(() => window.__app.store.state.daily.lastRepair), '2027-03-10');

  // One repair a week: three days after a repair there is no new offer.
  const recent = { ...save, daily: { ...streak, lastRepair: '2027-03-07' } };
  const fourth = await phone(t, { query: '?ads=mock&fast&debug', save: recent, fixedTime: at(10) });
  await fourth.waitForSelector('.screen.home');
  await fourth.waitForTimeout(300);
  assert.equal(await openSheets(fourth), 0);
});

test('after a restore, Settings stops offering to sell Remove Ads', async (t) => {
  const page = await phone(t, { query: '?ads=mock&fast&debug', save: { level: 5, stats: { solved: 4 } } });
  await page.waitForSelector('.screen.home');
  // Buy it, then pretend the save was lost (a reinstall): the store still knows.
  await page.locator('.links .pill', { hasText: 'Remove ads' }).click();
  await page.locator('.sheet .primary', { hasText: 'Remove ads' }).click();
  await page.waitForFunction(() => !document.querySelector('.sheet-wrap:not(.out)'));
  await page.evaluate(() => {
    window.__app.store.state.removeAds = false;
    window.__app.refresh();
  });
  await page.locator('.links .pill', { hasText: 'Settings' }).click();
  assert.equal(await page.locator('.sheet-wrap:not(.out) .row', { hasText: 'Remove ads' }).count(), 1);
  await page.locator('.sheet-wrap:not(.out) .row', { hasText: 'Restore purchases' }).click();
  await page.waitForFunction(() => window.__app.store.state.removeAds === true);
  await page.waitForFunction(() => document.querySelectorAll('.sheet-wrap:not(.out)').length === 1);
  assert.equal(await page.locator('.sheet-wrap:not(.out) .row', { hasText: 'Remove ads' }).count(), 0);
  assert.equal(await page.locator('.sheet-wrap:not(.out) .row', { hasText: 'Restore purchases' }).count(), 1);
});

test('everything fits on a small phone', async (t) => {
  const page = await phone(t, { width: 320, height: 568, query: '?level=150' });
  const view = { w: 320, h: 568 };
  const board = await page.locator('.board').boundingBox();
  const tools = await page.locator('.tools').boundingBox();
  const hud = await page.locator('.hud').boundingBox();
  assert.ok(board.x >= 0 && board.x + board.width <= view.w, 'the board fits across');
  assert.ok(board.y >= hud.y + hud.height - 1, 'the board starts below the HUD');
  assert.ok(board.y + board.height <= tools.y + 1, 'the board ends above the buttons');
  assert.ok(tools.y + tools.height <= view.h);
  const block = await page.locator('.block').first().boundingBox();
  assert.ok(block.width >= 26, `blocks are tappable (${block.width}px)`);

  await page.locator('.topbar .icon-btn').first().click();
  await page.waitForSelector('.screen.home');
  for (const sel of ['.logo', '.play', '.daily', '.links']) {
    const box = await page.locator(sel).boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= view.h, `${sel} is on screen`);
  }
  // Every sheet opens and closes.
  for (const name of ['Stats', 'How to play', 'Settings']) {
    await page.locator('.links .pill', { hasText: name }).click();
    await page.waitForSelector('.sheet');
    const sheet = await page.locator('.sheet').boundingBox();
    assert.ok(sheet.y >= 0, `${name} fits`);
    await page.locator('.sheet-head .icon-btn').click();
    await page.waitForFunction(() => !document.querySelector('.sheet-wrap:not(.out)'));
  }
});

test('the privacy and support pages load', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const plain = await context.newPage();
  for (const [file, heading] of [['privacy.html', 'Privacy policy'], ['support.html', 'Help and contact']]) {
    const response = await plain.goto(base + file);
    assert.equal(response.status(), 200);
    assert.equal(await plain.locator('h1').innerText(), heading);
  }
});
