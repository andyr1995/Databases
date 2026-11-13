// platform.persist: Preferences first, one-time migration from localStorage.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPersist } from '../src/bridge/persist.ts';
import { quiet } from './helpers.js';

function fakePreferences(initial = {}) {
  const data = new Map(Object.entries(initial));
  const calls = [];
  return {
    data,
    calls,
    failGet: false,
    failSet: false,
    async get({ key }) {
      calls.push(`get:${key}`);
      if (this.failGet) throw new Error('Preferences.get failed');
      return { value: data.has(key) ? data.get(key) : null };
    },
    async set({ key, value }) {
      calls.push(`set:${key}`);
      if (this.failSet) throw new Error('Preferences.set failed');
      data.set(key, value);
    },
  };
}

function fakeLocalStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    removeItem: (key) => void data.delete(key),
  };
}

test('get() resolves null for a key that exists nowhere', async () => {
  const persist = createPersist(fakePreferences(), fakeLocalStorage(), quiet);
  assert.equal(await persist.get('save.v1'), null);
});

test('set() then get() round-trips through Preferences', async () => {
  const prefs = fakePreferences();
  const persist = createPersist(prefs, fakeLocalStorage(), quiet);
  assert.equal(await persist.set('save.v1', '{"level":3}'), undefined);
  assert.equal(prefs.data.get('save.v1'), '{"level":3}');
  assert.equal(await persist.get('save.v1'), '{"level":3}');
});

test('an empty string is a value, not "absent"', async () => {
  const persist = createPersist(fakePreferences({ k: '' }), fakeLocalStorage({ k: 'old' }), quiet);
  assert.equal(await persist.get('k'), '');
});

test('first read migrates a value that only localStorage has', async () => {
  const prefs = fakePreferences();
  const legacy = fakeLocalStorage({ 'save.v1': '{"level":7}' });
  const persist = createPersist(prefs, legacy, quiet);

  assert.equal(await persist.get('save.v1'), '{"level":7}');
  assert.equal(prefs.data.get('save.v1'), '{"level":7}', 'copied into Preferences');
  assert.equal(legacy.data.has('save.v1'), false, 'and removed from localStorage once the copy is confirmed');

  prefs.calls.length = 0;
  assert.equal(await persist.get('save.v1'), '{"level":7}');
  assert.deepEqual(prefs.calls, ['get:save.v1'], 'the second read is served by Preferences alone');
});

test('Preferences wins over a leftover localStorage value', async () => {
  const prefs = fakePreferences({ 'save.v1': 'new' });
  const legacy = fakeLocalStorage({ 'save.v1': 'old' });
  const persist = createPersist(prefs, legacy, quiet);
  assert.equal(await persist.get('save.v1'), 'new');
  assert.equal(legacy.data.get('save.v1'), 'old', 'untouched: no migration was needed');
});

test('a failed migration write keeps the localStorage copy for next time', async () => {
  const prefs = fakePreferences();
  prefs.failSet = true;
  const legacy = fakeLocalStorage({ 'save.v1': 'old' });
  const persist = createPersist(prefs, legacy, quiet);
  assert.equal(await persist.get('save.v1'), 'old');
  assert.equal(legacy.data.get('save.v1'), 'old');

  prefs.failSet = false;
  assert.equal(await persist.get('save.v1'), 'old');
  assert.equal(prefs.data.get('save.v1'), 'old');
  assert.equal(legacy.data.has('save.v1'), false);
});

test('neither call rejects when Preferences is broken', async () => {
  const prefs = fakePreferences();
  prefs.failGet = true;
  prefs.failSet = true;
  const legacy = fakeLocalStorage({ a: 'from-localStorage' });
  const persist = createPersist(prefs, legacy, quiet);
  assert.equal(await persist.get('a'), 'from-localStorage', 'falls back to what localStorage has');
  assert.equal(legacy.data.get('a'), 'from-localStorage', 'and does not delete it');
  assert.equal(await persist.get('missing'), null);
  assert.equal(await persist.set('a', 'x'), undefined);
});

test('neither call rejects when the plugin throws synchronously or localStorage throws', async () => {
  const exploding = {
    get() {
      throw new Error('no bridge');
    },
    set() {
      throw new Error('no bridge');
    },
  };
  const legacy = {
    getItem() {
      throw new Error('SecurityError');
    },
    removeItem() {
      throw new Error('SecurityError');
    },
  };
  const persist = createPersist(exploding, legacy, quiet);
  assert.equal(await persist.get('k'), null);
  assert.equal(await persist.set('k', 'v'), undefined);
});

test('works without any localStorage', async () => {
  const persist = createPersist(fakePreferences({ k: 'v' }), null, quiet);
  assert.equal(await persist.get('k'), 'v');
  assert.equal(await persist.get('other'), null);
});

test('a Preferences result without a value field counts as absent', async () => {
  const prefs = { get: async () => ({}), set: async () => {} };
  const persist = createPersist(prefs, fakeLocalStorage(), quiet);
  assert.equal(await persist.get('k'), null);
});
