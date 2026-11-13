// viewport.ts reads the home-indicator inset from CSS. There is no browser here, so this
// runs it against a minimal stand-in for the DOM; the real thing needs a device.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { browserViewport } from '../src/bridge/viewport.ts';

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
  for (const name of ['document', 'window', 'getComputedStyle']) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
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
