// The small platform members: haptic, share, openExternal, appReady, onActiveChange.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createActivityWatch, createAppState, createOnBack } from '../src/bridge/app-state.ts';
import { createHaptic } from '../src/bridge/haptics.ts';
import { createShare } from '../src/bridge/share.ts';
import { createAppReady, createOpenExternal } from '../src/bridge/system.ts';
import { createFakeAndroidApp } from './helpers-android.js';
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
  // (Android: when the chooser returns without another app having come to the front)
  const share = createShare({ share: () => Promise.reject(new Error('Share canceled')) });
  assert.equal(await share({ text: 'x' }), 'cancelled');

  const abort = createShare({ share: () => Promise.reject(Object.assign(new Error('The user aborted a request'), { name: 'AbortError' })) });
  assert.equal(await abort({ text: 'x' }), 'cancelled');

  const plain = createShare({ share: () => Promise.reject({ errorMessage: 'Share canceled' }) });
  assert.equal(await plain({ text: 'x' }), 'cancelled');
});

test('share: what the Android share sheet answers', async () => {
  // SharePlugin.java: resolves { activityType: <package of the chosen app, or ''> } once the player is back
  const calls = [];
  const share = createShare({ share: async (opts) => (calls.push(opts), { activityType: '' }) });
  assert.equal(await share({ title: 'First Come #12', text: 'Solved', url: 'https://example.com/' }), 'shared');
  // One text extra for the target, the title as its subject; no separate url (Android would glue it on with a space).
  assert.deepEqual(calls, [{ title: 'First Come #12', text: 'Solved\nhttps://example.com/' }]);
});

test('share: any other problem is "failed", and nothing rejects', async () => {
  for (const message of [
    'Error sharing item',
    "Can't share while sharing is in progress",
    'Must provide at least url, text or files',
    'Must provide a URL or Message or files', // Android
    'Unsupported url', // Android
    '',
  ]) {
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

// --- Android: the activity behind onActiveChange ----------------------------------------------

test('android: onActiveChange reports leaving and coming back, not things that only lie on top of the game', async () => {
  const app = createFakeAndroidApp();
  const onActiveChange = createAppState(app, quiet);
  const seen = [];
  onActiveChange((active) => seen.push(active));
  await settle();

  app.paused(); // a full-screen ad, the Play purchase sheet, the share sheet: paused, never stopped
  app.resumed();
  assert.deepEqual(seen, [true], 'only that the game is in front, which the first event of a launch could not say');
  app.paused();
  app.resumed();
  assert.deepEqual(seen, [true], 'and never twice');

  app.paused();
  app.stopped(); // Home, or a Custom Tab over the game
  app.resumed();
  assert.deepEqual(seen, [true, false, true]);
});

test('android: the activity watch passes on every pause and resume, through one pair of native listeners', async () => {
  const app = createFakeAndroidApp();
  const onActivity = createActivityWatch(app, 'android', quiet);
  assert.equal(app.calls.length, 0, 'nothing is registered until someone listens');
  const a = [];
  const b = [];
  onActivity((resumed) => a.push(resumed));
  onActivity((resumed) => b.push(resumed));
  onActivity(() => {
    throw new Error('bug');
  });
  await settle();
  assert.deepEqual(app.calls.map((c) => c.event).sort(), ['pause', 'resume']);

  app.paused();
  app.resumed();
  app.paused();
  app.resumed();
  assert.deepEqual(a, [false, true, false, true]);
  assert.deepEqual(b, a);
});

test('the activity watch is Android only, and survives a failing App plugin', async () => {
  const ios = createFakeAndroidApp();
  createActivityWatch(ios, 'ios', quiet)(() => assert.fail('never called'));
  await settle();
  assert.equal(ios.calls.length, 0);

  const broken = createFakeAndroidApp();
  broken.listenersFail = true;
  const onActivity = createActivityWatch(broken, 'android', quiet);
  assert.equal(onActivity(() => {}), undefined);
  assert.equal(onActivity(undefined), undefined);
  await settle();
  broken.listenersFail = false;
  const seen = [];
  onActivity((resumed) => seen.push(resumed)); // the next subscriber registers them after all
  await settle();
  broken.paused();
  assert.deepEqual(seen, [false]);
});

// --- onBack ---------------------------------------------------------------------------------------

test('android: Back works before the game has asked for it: with no handler it puts the app in the background', async () => {
  // AppPlugin.java swallows every Back press, and without a page listener it only steps the
  // web view back in its history: nothing at all in a one-page game. The game registers its
  // handler late in its start-up and not at all on its "Something went wrong" screen.
  const app = createFakeAndroidApp();
  const onBack = createOnBack(app, 'android', quiet);
  await settle();
  assert.deepEqual(app.calls, [{ name: 'addListener', event: 'backButton' }], 'listening from the moment the bridge is installed');

  app.pressBack();
  await settle();
  assert.equal(app.minimized, 1, 'like Home: the task goes to the back');
  assert.equal(app.wentBackInHistory, 0);

  // The game's handler, once it arrives, is asked through that same listener.
  let asked = 0;
  onBack(() => ++asked > 0);
  await settle();
  app.pressBack();
  await settle();
  assert.equal(asked, 1);
  assert.equal(app.minimized, 1);
  assert.equal(app.listenerCount('backButton'), 1);

  // And when the handler is taken away again, Back leaves the app as before.
  onBack(null);
  app.pressBack();
  await settle();
  assert.equal(asked, 1);
  assert.equal(app.minimized, 2);
});

test('android: onBack asks the game on every press and puts the app in the background when it declines', async () => {
  const app = createFakeAndroidApp();
  const onBack = createOnBack(app, 'android', quiet);
  let handled = true;
  let presses = 0;
  assert.equal(
    onBack(() => {
      presses++;
      return handled;
    }),
    undefined,
  );
  await settle();
  assert.deepEqual(app.calls, [{ name: 'addListener', event: 'backButton' }]);

  app.pressBack(); // the game closed a sheet
  app.pressBack(); // the game went back to Home
  assert.equal(presses, 2);
  assert.equal(app.minimized, 0);

  handled = false; // already on Home with nothing open
  app.pressBack();
  await settle();
  assert.equal(presses, 3);
  assert.equal(app.minimized, 1, 'App.minimizeApp(): the task goes to the back, the page stays alive');
  assert.equal(app.calls.some((c) => c.name === 'exitApp'), false);
});

test('android: only a real true keeps the app in front; a handler that throws lets Back leave the app', async () => {
  const app = createFakeAndroidApp();
  const onBack = createOnBack(app, 'android', quiet);
  for (const [handler, minimized] of [
    [() => 'yes', 1],
    [() => undefined, 2],
    [
      () => {
        throw new Error('bug in the game');
      },
      3,
    ],
    [() => true, 3],
  ]) {
    onBack(handler);
    await settle();
    app.pressBack();
    await settle();
    assert.equal(app.minimized, minimized);
  }
});

test('android: only one handler is kept, and only one native listener', async () => {
  const app = createFakeAndroidApp();
  const onBack = createOnBack(app, 'android', quiet);
  const calls = [];
  onBack(() => calls.push('first') > 0);
  onBack(() => calls.push('second') > 0);
  await settle();
  assert.equal(app.listenerCount('backButton'), 1);
  app.pressBack();
  assert.deepEqual(calls, ['second']);
});

test('android: onBack survives a failing App plugin and bad arguments', async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const app = createFakeAndroidApp();
    app.listenersFail = true;
    const onBack = createOnBack(app, 'android', quiet);
    assert.equal(onBack(() => false), undefined);
    assert.equal(onBack(undefined), undefined);
    await settle();
    app.listenersFail = false;
    onBack(() => false); // the listener that could not be registered is registered now
    await settle();
    assert.equal(app.listenerCount('backButton'), 1);

    app.minimizeApp = () => Promise.reject(new Error('minimizeApp failed'));
    app.pressBack();
    app.minimizeApp = () => {
      throw new Error('no bridge');
    };
    app.pressBack();
    await settle();
    await settle();
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('on iPhone onBack does nothing at all', async () => {
  const app = createFakeAndroidApp();
  const onBack = createOnBack(app, 'ios', quiet);
  assert.equal(onBack(() => assert.fail('never called')), undefined);
  await settle();
  assert.deepEqual(app.calls, []);
});
