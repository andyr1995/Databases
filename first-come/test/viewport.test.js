// viewport.ts reads the home-indicator inset from CSS. There is no browser here, so this
// runs it against a minimal stand-in for the DOM. What only a browser can show (that the
// probe's size really follows the inset under the game's stylesheet) is checked in
// test/viewport-browser.test.js where Chrome is installed; the rest needs a device.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { browserViewport, SAFE_AREA_BOTTOM_CSS } from '../src/bridge/viewport.ts';

const saved = {};
let dom;

function fakeDom({ inset = '34px', innerWidth = 390 } = {}) {
  const listeners = {};
  const body = {
    children: [],
    appendChild(el) {
      el.isConnected = true;
      body.children.push(el);
    },
  };
  return {
    inset,
    listeners,
    body,
    document: {
      body,
      documentElement: { clientWidth: innerWidth },
      createElement: (tag) => ({ tag, style: {}, attributes: {}, isConnected: false, setAttribute(k, v) { this.attributes[k] = v; } }),
    },
    window: { innerWidth, addEventListener: (type, cb) => (listeners[type] ??= []).push(cb) },
  };
}

beforeEach(() => {
  dom = fakeDom();
  for (const name of ['document', 'window', 'getComputedStyle', 'ResizeObserver']) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  globalThis.document = dom.document;
  globalThis.window = dom.window;
  globalThis.getComputedStyle = () => ({ paddingBottom: dom.inset });
});

afterEach(() => {
  for (const [name, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

test('safeAreaBottom reads env(safe-area-inset-bottom) through one hidden probe element', () => {
  const viewport = browserViewport();
  assert.equal(dom.body.children.length, 0, 'nothing is added to the page until it is needed');
  assert.equal(viewport.safeAreaBottom(), 34);
  assert.equal(viewport.safeAreaBottom(), 34);
  assert.equal(dom.body.children.length, 1);
  const probe = dom.body.children[0];
  assert.match(probe.style.cssText, /env\(safe-area-inset-bottom/);
  assert.match(probe.style.cssText, /visibility:hidden/);
  assert.match(probe.style.cssText, /pointer-events:none/);
  assert.equal(probe.attributes['aria-hidden'], 'true');

  dom.inset = '21px'; // landscape
  assert.equal(viewport.safeAreaBottom(), 21);
});

test('safeAreaBottom is 0 when there is no inset or the value is unusable', () => {
  const viewport = browserViewport();
  for (const value of ['0px', '', 'auto', undefined]) {
    dom.inset = value;
    assert.equal(viewport.safeAreaBottom(), 0, String(value));
  }
});

test('the probe is recreated if the game wipes the page', () => {
  const viewport = browserViewport();
  viewport.safeAreaBottom();
  dom.body.children[0].isConnected = false;
  viewport.safeAreaBottom();
  assert.equal(dom.body.children.length, 2);
});

test('width and change notifications come from the window', () => {
  const viewport = browserViewport();
  assert.equal(viewport.width(), 390);
  let changes = 0;
  viewport.onChange(() => changes++);
  dom.listeners.resize.forEach((cb) => cb());
  dom.listeners.orientationchange.forEach((cb) => cb());
  assert.equal(changes, 2);
});

test('without a DOM everything degrades to 0 instead of throwing', () => {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.getComputedStyle;
  const viewport = browserViewport();
  assert.equal(viewport.safeAreaBottom(), 0);
  assert.equal(viewport.width(), 0);
  assert.equal(viewport.onChange(() => {}), undefined);
});

test('the inset is read the way the game stylesheet must write it: Capacitor\'s variable on Android, env() otherwise', () => {
  // SystemBars.java sets --safe-area-inset-bottom on the root element (0px when it has padded
  // the web view itself, the real inset when the web view runs edge to edge). iOS sets no
  // such variable, so env() applies there.
  assert.equal(SAFE_AREA_BOTTOM_CSS, 'var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))');
  const viewport = browserViewport();
  viewport.safeAreaBottom();
  const css = dom.body.children[0].style.cssText;
  assert.ok(css.includes(`padding:0 0 ${SAFE_AREA_BOTTOM_CSS} 0`), css);
  assert.ok(css.includes(`height:${SAFE_AREA_BOTTOM_CSS}`), 'the height follows the inset too, for the observer');
  // The game's stylesheet says `* { box-sizing: border-box }`. In a border box a height equal to
  // the padding leaves a content box of nothing, and the content box is what a ResizeObserver
  // watches: the probe has to opt out. (What a browser makes of it: test/viewport-browser.test.js.)
  assert.ok(css.includes('box-sizing:content-box;'), css);
});

test('a change of the inset that does not resize the window is noticed where ResizeObserver exists', () => {
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      observers.push(this);
    }
    observe(el) {
      this.observed.push(el);
    }
  };
  const viewport = browserViewport();
  let changes = 0;
  viewport.onChange(() => changes++);
  assert.equal(observers.length, 1);
  assert.deepEqual(observers[0].observed, [dom.body.children[0]], 'it watches the probe');

  dom.inset = '48px'; // the player switched from gesture to three-button navigation
  observers[0].callback([]);
  assert.equal(changes, 1);
  assert.equal(viewport.safeAreaBottom(), 48);
});

test('a probe that replaces one the game wiped away is watched as well, by the same observer', () => {
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      observers.push(this);
    }
    observe(el) {
      this.observed.push(el);
    }
  };
  const viewport = browserViewport();
  let first = 0;
  let second = 0;
  viewport.onChange(() => first++);
  viewport.onChange(() => second++);
  assert.equal(observers.length, 1, 'one observer, however many listeners');

  dom.body.children[0].isConnected = false; // the game replaced the page's content
  viewport.safeAreaBottom();
  assert.equal(dom.body.children.length, 2);
  assert.deepEqual(observers[0].observed, [dom.body.children[0], dom.body.children[1]]);
  observers[0].callback([]);
  assert.deepEqual([first, second], [1, 1]);
});

test('a ResizeObserver that cannot be used does not break the resize events', () => {
  globalThis.ResizeObserver = class {
    constructor() {
      throw new Error('not allowed');
    }
  };
  const viewport = browserViewport();
  let changes = 0;
  assert.equal(viewport.onChange(() => changes++), undefined);
  dom.listeners.resize.forEach((cb) => cb());
  assert.equal(changes, 1);
});
