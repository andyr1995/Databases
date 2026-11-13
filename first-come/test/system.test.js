// The small platform members: haptic, share, openExternal, appReady, onActiveChange.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppState } from '../src/bridge/app-state.ts';
import { createHaptic } from '../src/bridge/haptics.ts';
import { createShare } from '../src/bridge/share.ts';
import { createAppReady, createOpenExternal } from '../src/bridge/system.ts';
import { quiet, settle } from './helpers.js';

// --- haptic ---------------------------------------------------------------------------------

function fakeHaptics() {
  const calls = [];
  return {
    calls,
    impact: async (opts) => void calls.push(['impact', opts.style]),
    notification: async (opts) => void calls.push(['notification', opts.type]),
  };
}

test('haptic maps the five kinds to impact weights and notification patterns', () => {
  const haptics = fakeHaptics();
  const haptic = createHaptic(haptics);
  for (const kind of ['tap', 'soft', 'heavy', 'success', 'error']) assert.equal(haptic(kind), undefined);
  assert.deepEqual(haptics.calls, [
    ['impact', 'LIGHT'],
    ['impact', 'MEDIUM'],
    ['impact', 'HEAVY'],
    ['notification', 'SUCCESS'],
    ['notification', 'ERROR'],
  ]);
});

test('an unknown kind is a light tap, like on the web', () => {
  const haptics = fakeHaptics();
  createHaptic(haptics)('wobble');
  assert.deepEqual(haptics.calls, [['impact', 'LIGHT']]);
});

test('haptic never throws and never leaves a rejection behind', async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const rejecting = createHaptic({
      impact: () => Promise.reject(new Error('Haptics not implemented')),
      notification: () => Promise.reject(new Error('Haptics not implemented')),
    });
    const throwing = createHaptic({
      impact: () => {
        throw new Error('no bridge');
      },
      notification: () => {
        throw new Error('no bridge');
      },
    });
    for (const kind of ['tap', 'soft', 'heavy', 'success', 'error']) {
      assert.equal(rejecting(kind), undefined);
      assert.equal(throwing(kind), undefined);
    }
    await settle();
    await settle();
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

// --- share ----------------------------------------------------------------------------------

test('share sends text and link as one string and resolves "shared"', async () => {
  const calls = [];
  const share = createShare({ share: async (opts) => (calls.push(opts), { activityType: 'com.apple.UIKit.activity.Message' }) });
  assert.equal(await share({ title: 'Game', text: 'I solved level 12', url: 'https://example.com/play' }), 'shared');
  assert.deepEqual(calls, [{ title: 'Game', text: 'I solved level 12\nhttps://example.com/play' }]);

  assert.equal(await share({ text: 'Just text' }), 'shared');
  assert.deepEqual(calls[1], { text: 'Just text' });
});

test('share: a dismissed sheet is "cancelled"', async () => {
  // iOS and Android both reject with exactly this message when the sheet is closed
  const share = createShare({ share: () => Promise.reject(new Error('Share canceled')) });
  assert.equal(await share({ text: 'x' }), 'cancelled');

  const abort = createShare({ share: () => Promise.reject(Object.assign(new Error('The user aborted a request'), { name: 'AbortError' })) });
  assert.equal(await abort({ text: 'x' }), 'cancelled');

  const plain = createShare({ share: () => Promise.reject({ errorMessage: 'Share canceled' }) });
  assert.equal(await plain({ text: 'x' }), 'cancelled');
});

test('share: any other problem is "failed", and nothing rejects', async () => {
  for (const message of ['Error sharing item', "Can't share while sharing is in progress", 'Must provide at least url, text or files', '']) {
    const share = createShare({ share: () => Promise.reject(new Error(message)) });
    assert.equal(await share({ text: 'x' }), 'failed', message);
  }
  const throwing = createShare({
    share: () => {
      throw new Error('no bridge');
    },
  });
  assert.equal(await throwing({ text: 'x' }), 'failed');

  const never = createShare({ share: async () => assert.fail('must not be called without anything to share') });
  assert.equal(await never({ text: '' }), 'failed');
  assert.equal(await never(undefined), 'failed');
});

// --- openExternal -----------------------------------------------------------------------------

test('openExternal opens absolute https URLs in the in-app browser', () => {
  const opened = [];
  const open = createOpenExternal({ open: async (opts) => void opened.push(opts) }, quiet);
  assert.equal(open('https://example.com/privacy?x=1#top'), undefined);
  assert.deepEqual(opened, [{ url: 'https://example.com/privacy?x=1#top' }]);
});

test('openExternal ignores everything that is not an absolute https URL', () => {
  const opened = [];
  const open = createOpenExternal({ open: async (opts) => void opened.push(opts) }, quiet);
  for (const url of [
    'http://example.com',
    'javascript:alert(1)',
    'itms-apps://itunes.apple.com/app/id1',
    'mailto:someone@example.com',
    'file:///etc/passwd',
    '/privacy.html',
    'privacy.html',
    '//example.com/x',
    'example.com',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(open(url), undefined);
  }
  assert.deepEqual(opened, []);
});

test('openExternal never throws and never leaves a rejection behind', async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    createOpenExternal({ open: () => Promise.reject(new Error('Unable to display URL')) }, quiet)('https://example.com');
    createOpenExternal(
      {
        open: () => {
          throw new Error('no bridge');
        },
      },
      quiet,
    )('https://example.com');
    await settle();
    await settle();
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

// --- appReady ---------------------------------------------------------------------------------

test('appReady hides the launch screen and survives a failing plugin', async () => {
  const calls = [];
  const ready = createAppReady({ hide: async (opts) => void calls.push(opts) }, quiet);
  assert.equal(ready(), undefined);
  assert.deepEqual(calls, [{ fadeOutDuration: 200 }]);

  const broken = createAppReady({ hide: () => Promise.reject(new Error('Unable to hide Splash Screen')) }, quiet);
  assert.equal(broken(), undefined);
  await settle();
});

// --- onActiveChange ---------------------------------------------------------------------------

function fakeApp() {
  const handlers = [];
  return {
    handlers,
    registrations: 0,
    async addListener(event, fn) {
      this.registrations++;
      assert.equal(event, 'appStateChange');
      handlers.push(fn);
      return { remove: async () => {} };
    },
    fire: (isActive) => handlers.forEach((fn) => fn({ isActive })),
  };
}

test('onActiveChange forwards the App plugin state to every subscriber through one native listener', async () => {
  const app = fakeApp();
  const onActiveChange = createAppState(app, quiet);
  const a = [];
  const b = [];
  assert.equal(onActiveChange((active) => a.push(active)), undefined);
  onActiveChange((active) => b.push(active));
  await settle();
  assert.equal(app.registrations, 1);

  app.fire(false);
  app.fire(true);
  assert.deepEqual(a, [false, true]);
  assert.deepEqual(b, [false, true]);
});

test('onActiveChange drops repeats and isolates a throwing subscriber', async () => {
  const app = fakeApp();
  const onActiveChange = createAppState(app, quiet);
  const seen = [];
  onActiveChange(() => {
    throw new Error('bug in the game');
  });
  onActiveChange((active) => seen.push(active));
  await settle();
  app.fire(true);
  app.fire(true);
  app.fire(false);
  assert.deepEqual(seen, [true, false]);
});

test('onActiveChange survives a failing App plugin and bad arguments', async () => {
  const onActiveChange = createAppState({ addListener: () => Promise.reject(new Error('App not implemented')) }, quiet);
  assert.equal(onActiveChange(() => {}), undefined);
  assert.equal(onActiveChange(undefined), undefined);
  await settle();
});
