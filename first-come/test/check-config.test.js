// scripts/check-config.mjs: the first step of `npm run sync`. It asks both configure scripts,
// in their --check mode, whether they would refuse app.config.json or their project, so that
// a value only one platform refuses stops the sync before anything has been written.
//
// The tests run it on fresh copies of Capacitor's iOS and Android templates in a temporary
// folder, with a made-up configuration; only the first reads the real files.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkConfig } from '../scripts/check-config.mjs';
import { configureAndroid } from '../scripts/configure-android.mjs';
import { configureIos } from '../scripts/configure-ios.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templates = path.join(root, 'node_modules', '@capacitor', 'cli', 'assets');

/** A complete app.config.json for both platforms that no real app will ever have. */
const FIXTURE = Object.freeze({
  appId: 'com.example.fixture',
  appName: 'Fixture App',
  version: '1.0.0',
  build: 1,
  webDir: '../fixture-web',
  admob: {
    testing: true,
    ios: {
      appId: 'ca-app-pub-1111111111111111~2222222222',
      banner: 'ca-app-pub-1111111111111111/3333333333',
      interstitial: 'ca-app-pub-1111111111111111/4444444444',
      rewarded: 'ca-app-pub-1111111111111111/5555555555',
    },
    android: {
      appId: 'ca-app-pub-1111111111111111~6666666666',
      banner: 'ca-app-pub-1111111111111111/7777777777',
      interstitial: 'ca-app-pub-1111111111111111/8888888888',
      rewarded: 'ca-app-pub-1111111111111111/9999999999',
    },
  },
  iap: { removeAdsProductId: 'fixture_remove_ads' },
  trackingUsageDescription: 'Fixture sentence for the tracking prompt, long enough to be one.',
});

const scratch = mkdtempSync(path.join(os.tmpdir(), 'check-config-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

/** A temporary app folder with both of Capacitor's untouched templates, the real resources/ and the fixture config. */
function freshApp(configOverrides = {}) {
  counter += 1;
  const dir = path.join(scratch, `app-${counter}`);
  for (const [platform, archive] of [['ios', 'ios-spm-template.tar.gz'], ['android', 'android-template.tar.gz']]) {
    mkdirSync(path.join(dir, platform), { recursive: true });
    execFileSync('tar', ['-xzf', path.join(templates, archive), '-C', path.join(dir, platform)]);
  }
  cpSync(path.join(root, 'resources'), path.join(dir, 'resources'), { recursive: true });
  writeConfig(dir, configOverrides);
  return dir;
}

function writeConfig(dir, overrides) {
  writeFileSync(path.join(dir, 'app.config.json'), JSON.stringify({ ...FIXTURE, ...overrides }, null, 2));
}

/** Every file under `dir` with its content, to prove that nothing was written. */
function snapshot(dir) {
  const files = new Map();
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(path.relative(dir, full).split(path.sep).join('/'), readFileSync(full).toString('base64'));
    }
  };
  walk(dir);
  return files;
}

test('the committed app.config.json and projects are accepted by both platforms', () => {
  assert.deepEqual(checkConfig({ root }), []);
});

test('projects that are merely out of date are not refused, and the check writes nothing', () => {
  const dir = freshApp();
  const before = snapshot(dir);
  assert.deepEqual(checkConfig({ root: dir }), [], 'two untouched templates: everything is out of date, nothing is wrong');
  assert.deepEqual(snapshot(dir), before);

  configureIos({ root: dir });
  configureAndroid({ root: dir });
  const configured = snapshot(dir);
  assert.deepEqual(checkConfig({ root: dir }), []);
  assert.deepEqual(snapshot(dir), configured);
});

test('a bundle id with a hyphen is refused for Android before the Xcode project is touched', () => {
  const dir = freshApp();
  configureIos({ root: dir });
  configureAndroid({ root: dir });
  const before = snapshot(dir);

  // Apple accepts it (configure-ios would go on to write the new id into the Xcode project) ...
  writeConfig(dir, { appId: 'com.your-name.firstcome' });
  const beforeCheck = snapshot(dir);
  assert.ok(configureIos({ root: dir, check: true }).changed.length > 0, 'iPhone alone has no objection and a change to write');
  // ... Android cannot, and the check says so while both projects are still as they were.
  const refusals = checkConfig({ root: dir });
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].platform, 'Android');
  assert.match(refusals[0].message, /"appId" must be an Android package name/);
  assert.match(refusals[0].message, /"androidAppId": "com\.your_name\.firstcome"/, 'with the line that settles it');
  assert.deepEqual(snapshot(dir), beforeCheck);
  for (const [file, content] of before) {
    if (file !== 'app.config.json') assert.equal(beforeCheck.get(file), content, file);
  }

  // The offered line settles it: one id for Apple, another for Android.
  writeConfig(dir, { appId: 'com.your-name.firstcome', androidAppId: 'com.your_name.firstcome' });
  assert.deepEqual(checkConfig({ root: dir }), []);
  assert.match(configureIos({ root: dir }).summary, /\(com\.your-name\.firstcome\)/);
  assert.match(configureAndroid({ root: dir }).summary, /\(com\.your_name\.firstcome\)/);
});

test('what each platform refuses is reported for each, iPhone first', () => {
  // The version is wrong for both; the build number only for Google Play; the tracking sentence only for Apple.
  const dir = freshApp({ version: 'one', build: 2100000001, trackingUsageDescription: '' });
  const refusals = checkConfig({ root: dir });
  assert.deepEqual(
    refusals.map((refusal) => refusal.platform),
    ['iPhone', 'Android'],
  );
  assert.match(refusals[0].message, /"version" must be/);
  assert.match(refusals[0].message, /"trackingUsageDescription"/);
  assert.doesNotMatch(refusals[0].message, /2100000000/);
  assert.match(refusals[1].message, /"version" must be/);
  assert.match(refusals[1].message, /"build" must be a whole number from 1 to 2100000000/);
  assert.doesNotMatch(refusals[1].message, /trackingUsageDescription/);
});

test('a project one of the scripts cannot edit is reported too; anything but a refusal is a crash, not a report', () => {
  const dir = freshApp();
  rmSync(path.join(dir, 'android', 'app', 'src', 'main', 'res', 'values', 'styles.xml'));
  const refusals = checkConfig({ root: dir });
  assert.deepEqual(
    refusals.map((refusal) => refusal.platform),
    ['Android'],
  );
  assert.match(refusals[0].message, /is missing android\/app\/src\/main\/res\/values\/styles\.xml/);

  assert.throws(() => checkConfig({}), TypeError, 'a programming error is not swallowed');
});

test('run as a command it prints one line and exits 0 when both platforms accept', () => {
  const output = execFileSync(process.execPath, [path.join(root, 'scripts', 'check-config.mjs')], { encoding: 'utf8' });
  assert.equal(output.trim(), 'check:config: app.config.json and both native projects are fit for iPhone and for Android.');
  assert.throws(
    () => execFileSync(process.execPath, [path.join(root, 'scripts', 'check-config.mjs'), '--fix'], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => error.status === 2 && /unknown option --fix/.test(error.stderr),
  );
});
