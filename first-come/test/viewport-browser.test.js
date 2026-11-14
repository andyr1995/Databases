// viewport.ts in a real browser, on a page that carries the game's real stylesheet.
//
// test/viewport.test.js runs the same module against a stand-in DOM, which cannot know what
// CSS does. That is how a probe whose size never changed got through: the game's stylesheet
// makes every element a border box, and the observer watching the probe never fired. Here
// the real module (bundled the way build-bridge does it) meets the real css/app.css in
// headless Chrome. Skipped where there is no Chrome: see helpers-chrome.js.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { webDir } from './game/_web.js';
import { ChromeUnavailable, findChrome, runInChrome } from './helpers-chrome.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'viewport-browser-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A page with the game's stylesheet and viewport.ts as the global `Bridge`. */
async function pageWithTheGameStylesheet() {
  const stylesheet = path.join(webDir, 'css', 'app.css');
  assert.ok(existsSync(stylesheet), `${stylesheet}: the game's stylesheet`);
  const bundle = await build({
    entryPoints: [path.join(root, 'src', 'bridge', 'viewport.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'Bridge',
    target: ['safari15', 'chrome87'],
    write: false,
    logLevel: 'silent',
  });
  const file = path.join(scratch, 'page.html');
  writeFileSync(
    file,
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="stylesheet" href="${pathToFileURL(stylesheet).href}">
</head><body><script>${bundle.outputFiles[0].text}</script></body></html>`,
  );
  return pathToFileURL(file).href;
}

// Runs in the page. Two animation frames and a timer: time for style, layout and the
// observer's delivery, which happens while a frame is drawn.
const IN_THE_PAGE = `(async () => {
  const settled = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 30))));
  const viewport = Bridge.browserViewport();
  let changes = 0;
  viewport.onChange(() => changes++);
  await settled();
  const probe = document.body.lastElementChild;
  const report = {
    stylesheetApplies: getComputedStyle(document.body).boxSizing,
    probeBoxSizing: getComputedStyle(probe).boxSizing,
    probeHidden: getComputedStyle(probe).visibility + ' ' + probe.getBoundingClientRect().width,
    before: viewport.safeAreaBottom(),
    steps: [],
  };
  // What Capacitor's SystemBars plugin does when the player switches between gesture and
  // three-button navigation: it rewrites the variable. The window keeps its size.
  for (const value of ['48px', '24px', '0px', '24px']) {
    const seen = changes;
    document.documentElement.style.setProperty('--safe-area-inset-bottom', value);
    await settled();
    report.steps.push({ value, inset: viewport.safeAreaBottom(), noticed: changes - seen });
  }
  return report;
})()`;

test('in a browser, under the game\'s stylesheet, a change of the bottom inset alone is noticed', async (t) => {
  if (!findChrome()) return t.skip('no Chrome or Chromium on this machine');
  let report;
  try {
    report = await runInChrome(await pageWithTheGameStylesheet(), IN_THE_PAGE);
  } catch (error) {
    if (error instanceof ChromeUnavailable) return t.skip(`Chrome could not be used: ${error.message}`);
    throw error;
  }

  assert.equal(report.stylesheetApplies, 'border-box', 'the game\'s `* { box-sizing: border-box }` is in force on this page');
  assert.equal(report.probeBoxSizing, 'content-box', 'and the probe opts out of it');
  assert.equal(report.probeHidden, 'hidden 0', 'the probe shows nothing and takes no room');
  assert.equal(report.before, 0, 'no variable and no notch: env() gives 0');
  assert.deepEqual(
    report.steps.map((step) => [step.value, step.inset]),
    [
      ['48px', 48],
      ['24px', 24],
      ['0px', 0],
      ['24px', 24],
    ],
    'Capacitor\'s variable wins over env()',
  );
  for (const step of report.steps) assert.ok(step.noticed >= 1, `the change to ${step.value} reached onChange (${step.noticed} calls)`);
});
