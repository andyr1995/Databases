// scripts/configure-android.mjs: app.config.json and resources/android applied to the Android project.
//
// Most tests run the script on a fresh copy of Capacitor's own Android template (the archive the
// CLI unpacks for `cap add android`) in a temporary folder, so they prove the whole path from a
// newly added platform. Nothing here needs the Android SDK, Java or Gradle: what Gradle makes
// of the project is checked by the Android build workflow (ci/android-build.yml).
//
// Those tests use the made-up configuration and colours below, never the real app.config.json
// or the real colours: the real files are edited for every release (name, package name, version,
// build, AdMob ids) and none of those edits may turn a test red. Only the first test reads the
// real files, to check that the committed project is in step with them.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { androidPackageName, androidString, configureAndroid } from '../scripts/configure-android.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = path.join(root, 'node_modules', '@capacitor', 'cli', 'assets', 'android-template.tar.gz');

/** A complete, valid app.config.json that no real app will ever have. It has no iPhone settings at all. */
const FIXTURE = Object.freeze({
  appId: 'com.example.fixture',
  appName: 'Fixture App',
  version: '1.0.0',
  build: 1,
  webDir: '../fixture-web',
  admob: {
    testing: true,
    android: {
      appId: 'ca-app-pub-1111111111111111~2222222222',
      banner: 'ca-app-pub-1111111111111111/3333333333',
      interstitial: 'ca-app-pub-1111111111111111/4444444444',
      rewarded: 'ca-app-pub-1111111111111111/5555555555',
    },
  },
  iap: { removeAdsProductId: 'fixture_remove_ads' },
});
const COLOURS = Object.freeze({ iconBackground: '#112233', splashBackground: '#445566', statusBar: '#778899' });

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
const TOOLS_NS = 'http://schemas.android.com/tools';
const ADMOB_KEY = 'com.google.android.gms.ads.APPLICATION_ID';
const DENSITIES = { mdpi: [48, 108], hdpi: [72, 162], xhdpi: [96, 216], xxhdpi: [144, 324], xxxhdpi: [192, 432] };
const ICON_NAMES = ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png'];
const TEMPLATE_ART = [
  'drawable/splash.png',
  ...['land', 'port'].flatMap((way) => Object.keys(DENSITIES).map((density) => `drawable-${way}-${density}/splash.png`)),
  'drawable/ic_launcher_background.xml',
  'drawable-v24/ic_launcher_foreground.xml',
];

const scratch = mkdtempSync(path.join(os.tmpdir(), 'configure-android-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

/** A temporary app folder: Capacitor's untouched Android template, the real launcher icons, fixture colours and config. */
function freshApp(configOverrides = {}) {
  counter += 1;
  const dir = path.join(scratch, `app-${counter}`);
  mkdirSync(path.join(dir, 'android'), { recursive: true });
  execFileSync('tar', ['-xzf', template, '-C', path.join(dir, 'android')]);
  cpSync(path.join(root, 'resources', 'android'), path.join(dir, 'resources', 'android'), { recursive: true });
  writeFileSync(path.join(dir, 'resources', 'android', 'colors.json'), JSON.stringify(COLOURS));
  writeConfig(dir, configOverrides);
  return dir;
}

function writeConfig(dir, overrides) {
  writeFileSync(path.join(dir, 'app.config.json'), JSON.stringify({ ...FIXTURE, ...overrides }, null, 2));
}

const inAndroid = (dir, ...parts) => path.join(dir, 'android', ...parts);
const inMain = (dir, ...parts) => inAndroid(dir, 'app', 'src', 'main', ...parts);
const inRes = (dir, ...parts) => inMain(dir, 'res', ...parts);
const read = (file) => readFileSync(file, 'utf8');
const edit = (file, change) => writeFileSync(file, change(read(file)));
const lines = (file) => read(file).split('\n');

function xml(file) {
  return new DOMParser({
    onError: (level, message) => {
      throw new Error(`${file}: ${level}: ${message}`);
    },
  }).parseFromString(read(file), 'text/xml');
}
const elements = (node, tag) => Array.from(node.childNodes).filter((child) => child.nodeType === 1 && child.nodeName === tag);

/** The manifest's interesting parts, read with a real XML parser. */
function readManifest(dir) {
  const manifest = xml(inMain(dir, 'AndroidManifest.xml')).documentElement;
  const [application] = elements(manifest, 'application');
  const android = (node, name) => node.getAttributeNS(ANDROID_NS, name);
  return {
    application: (name) => android(application, name),
    activities: elements(application, 'activity').map((activity) => (name) => android(activity, name)),
    metaData: Object.fromEntries(elements(application, 'meta-data').map((data) => [android(data, 'name'), android(data, 'value')])),
    metaDataCount: elements(application, 'meta-data').length,
    providers: elements(application, 'provider').map((provider) => android(provider, 'name')),
    permissions: elements(manifest, 'uses-permission').map((permission) => android(permission, 'name')),
  };
}

/** name -> text of every element called `tag` directly under <resources> in a values file. */
function readValues(file, tag) {
  return Object.fromEntries(elements(xml(file).documentElement, tag).map((node) => [node.getAttribute('name'), node.textContent]));
}

/** One <style>: its parent and its items in order. */
function readStyle(dir, name) {
  const style = elements(xml(inRes(dir, 'values', 'styles.xml')).documentElement, 'style').find((node) => node.getAttribute('name') === name);
  return {
    parent: style.getAttribute('parent'),
    items: elements(style, 'item').map((item) => [item.getAttribute('name'), item.textContent, item.getAttributeNS(TOOLS_NS, 'targetApi') || undefined]),
  };
}

/** What Android shows for a <string> value: the reverse of the escaping the script applies. */
const shownByAndroid = (value) => value.replace(/\\(.)/g, '$1');

/** Every file under android/ with its content, to compare the project before and after a run. */
function snapshot(dir) {
  const files = new Map();
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(path.relative(dir, full).split(path.sep).join('/'), readFileSync(full).toString('base64'));
    }
  };
  walk(path.join(dir, 'android'));
  return files;
}

/** The smallest byte sequence the script's PNG check reads: signature, header chunk, end chunk. */
function pngHeader(width, height, colourType) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = colourType;
  const end = Buffer.alloc(12);
  end.write('IEND', 4, 'latin1');
  return Buffer.concat([header, end]);
}

// --- the committed project --------------------------------------------------------------------

test('the Android project in android/ is in step with app.config.json and resources/android', () => {
  const result = configureAndroid({ root, check: true });
  assert.deepEqual(
    result.changed,
    [],
    'These files are out of date. Run `npm run sync` and commit the result (never edit them by hand).',
  );
  assert.ok(result.unchanged.length >= 27, 'manifest, build files, strings, styles, colours, drawings, MainActivity and fifteen icons');
});

// --- from a freshly added platform ------------------------------------------------------------

test('a fresh template gets its package name, version and name from app.config.json', () => {
  const dir = freshApp({ appId: 'com.example.first_come2', appName: 'First & Last <Come>', version: '2.3.1', build: 47 });
  const result = configureAndroid({ root: dir });
  assert.ok(result.changed.includes('android/app/build.gradle'));
  assert.equal(result.summary, 'First & Last <Come> (com.example.first_come2) 2.3.1 build 47, portrait, targets Android API 36, runs on API 24 and later');

  const gradle = lines(inAndroid(dir, 'app', 'build.gradle')).map((line) => line.trim());
  for (const line of ['namespace = "com.example.first_come2"', 'applicationId "com.example.first_come2"', 'versionCode 47', 'versionName "2.3.1"']) {
    assert.equal(gradle.filter((other) => other === line).length, 1, line);
  }
  assert.ok(!read(inAndroid(dir, 'app', 'build.gradle')).includes('com.getcapacitor'), 'nothing of the template\'s own package name is left');

  const strings = readValues(inRes(dir, 'values', 'strings.xml'), 'string');
  assert.deepEqual(strings, {
    app_name: 'First & Last <Come>',
    title_activity_main: 'First & Last <Come>',
    package_name: 'com.example.first_come2',
    custom_url_scheme: 'com.example.first_come2',
  });
});

test('the manifest gains the AdMob app id, portrait, no cleartext traffic and the game category, and loses nothing', () => {
  const dir = freshApp();
  const before = lines(inMain(dir, 'AndroidManifest.xml'));
  configureAndroid({ root: dir });
  const manifest = readManifest(dir);

  assert.equal(manifest.metaData[ADMOB_KEY], FIXTURE.admob.android.appId);
  assert.equal(manifest.metaDataCount, 1);
  assert.equal(manifest.application('usesCleartextTraffic'), 'false');
  assert.equal(manifest.application('appCategory'), 'game');
  assert.equal(manifest.activities.length, 1);
  assert.equal(manifest.activities[0]('name'), '.MainActivity');
  assert.equal(manifest.activities[0]('screenOrientation'), 'portrait');
  // What the template needs is still there.
  assert.equal(manifest.application('label'), '@string/app_name');
  assert.equal(manifest.application('icon'), '@mipmap/ic_launcher');
  assert.equal(manifest.application('roundIcon'), '@mipmap/ic_launcher_round');
  assert.equal(manifest.activities[0]('theme'), '@style/AppTheme.NoActionBarLaunch');
  assert.equal(manifest.activities[0]('exported'), 'true');
  assert.deepEqual(manifest.providers, ['androidx.core.content.FileProvider']);
  assert.deepEqual(manifest.permissions, ['android.permission.INTERNET']);

  // Line by line: two lines lost their closing bracket to a new attribute, the rest is additions.
  const after = lines(inMain(dir, 'AndroidManifest.xml'));
  const trimmed = (list) => list.map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(trimmed(before.filter((line) => !after.includes(line))), ['android:theme="@style/AppTheme">', 'android:exported="true">']);
  assert.deepEqual(trimmed(after.filter((line) => !before.includes(line))), [
    'android:theme="@style/AppTheme"',
    'android:usesCleartextTraffic="false"',
    'android:appCategory="game">',
    'android:exported="true"',
    'android:screenOrientation="portrait">',
    '<!-- AdMob app id, from app.config.json. Google\'s advert library stops the app at launch without it. -->',
    '<meta-data',
    `android:name="${ADMOB_KEY}"`,
    `android:value="${FIXTURE.admob.android.appId}" />`,
  ]);
  // New attributes line up with the ones that were there.
  assert.ok(after.includes('        android:appCategory="game">'));
  assert.ok(after.includes('            android:screenOrientation="portrait">'));
  assert.ok(after.includes('        <meta-data'));
});

test('the build file changes in four lines and gains the two that load release.gradle', () => {
  const dir = freshApp();
  const before = lines(inAndroid(dir, 'app', 'build.gradle'));
  configureAndroid({ root: dir });
  const after = lines(inAndroid(dir, 'app', 'build.gradle'));
  const trimmed = (list) => list.map((line) => line.trim());

  assert.deepEqual(trimmed(before.filter((line) => !after.includes(line))), [
    'namespace = "com.getcapacitor.myapp"',
    'applicationId "com.getcapacitor.app"',
    'versionName "1.0"',
  ]);
  assert.deepEqual(trimmed(after.filter((line) => !before.includes(line))), [
    `namespace = "${FIXTURE.appId}"`,
    `applicationId "${FIXTURE.appId}"`,
    `versionName "${FIXTURE.version}"`,
    '// Release signing and the version code a CI run passes in: see release.gradle (scripts/configure-android.mjs).',
    "apply from: 'release.gradle'",
  ]);
  // Straight after the file Capacitor generates, so that it is the last word on signing.
  assert.equal(after[after.indexOf("apply from: 'capacitor.build.gradle'") + 2], "apply from: 'release.gradle'");
});

test('release.gradle takes the upload key and the version code from outside; nothing secret is in the project', () => {
  const dir = freshApp();
  configureAndroid({ root: dir });
  const release = read(inAndroid(dir, 'app', 'release.gradle'));
  for (const name of ['ANDROID_KEYSTORE_FILE', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD', 'ANDROID_VERSION_CODE']) {
    assert.ok(release.includes(`'${name}'`), name);
  }
  assert.ok(release.includes('project.findProperty(name) ?: System.getenv(name)'), 'a Gradle property first, then the environment');
  // The four values of the signing configuration are variables, never text written in the file.
  const assigned = [...release.matchAll(/^\s*(storeFile|storePassword|keyAlias|keyPassword)\s+(.*)$/gm)].map((match) => [match[1], match[2]]);
  assert.deepEqual(assigned, [
    ['storeFile', 'keystore'],
    ['storePassword', 'signingValues.ANDROID_KEYSTORE_PASSWORD'],
    ['keyAlias', 'signingValues.ANDROID_KEY_ALIAS'],
    ['keyPassword', 'signingValues.ANDROID_KEY_PASSWORD'],
  ]);
  // Outside release.gradle no build file mentions signing at all, so a debug build needs none of it.
  for (const file of ['build.gradle', 'app/build.gradle', 'variables.gradle', 'gradle.properties']) {
    assert.ok(!/signingConfig|storePassword|keyPassword/.test(read(inAndroid(dir, ...file.split('/')))), file);
  }

  const ignored = lines(inAndroid(dir, '.gitignore'));
  for (const rule of ['*.jks', '*.keystore', 'keystore.properties', '.kotlin/']) assert.ok(ignored.includes(rule), rule);
});

test('launch screen and system bars: the themes, the colours and the drawings', () => {
  const dir = freshApp();
  configureAndroid({ root: dir });

  assert.deepEqual(readStyle(dir, 'AppTheme.NoActionBarLaunch'), {
    parent: 'Theme.SplashScreen',
    items: [
      ['windowSplashScreenBackground', '@color/splash_background', undefined],
      ['windowSplashScreenAnimatedIcon', '@mipmap/ic_launcher_foreground', undefined],
      ['postSplashScreenTheme', '@style/AppTheme.NoActionBar', undefined],
      ['android:windowLightStatusBar', 'false', undefined],
      ['android:windowLightNavigationBar', 'false', '27'],
    ],
  });
  assert.deepEqual(readStyle(dir, 'AppTheme.NoActionBar'), {
    parent: 'Theme.AppCompat.DayNight.NoActionBar',
    items: [
      ['windowActionBar', 'false', undefined],
      ['windowNoTitle', 'true', undefined],
      ['android:background', '@null', undefined],
      ['android:windowBackground', '@color/system_bar', undefined],
      ['android:statusBarColor', '@color/system_bar', undefined],
      ['android:navigationBarColor', '@color/system_bar', undefined],
      ['android:windowLightStatusBar', 'false', undefined],
      ['android:windowLightNavigationBar', 'false', '27'],
    ],
  });
  // The application theme is the template's, untouched.
  assert.equal(readStyle(dir, 'AppTheme').parent, 'Theme.AppCompat.Light.DarkActionBar');
  assert.equal(readStyle(dir, 'AppTheme').items.length, 3);

  assert.deepEqual(readValues(inRes(dir, 'values', 'colors.xml'), 'color'), { splash_background: COLOURS.splashBackground, system_bar: COLOURS.statusBar });
  assert.deepEqual(readValues(inRes(dir, 'values', 'ic_launcher_background.xml'), 'color'), { ic_launcher_background: COLOURS.iconBackground });

  // The drawing the SplashScreen plugin looks up by the name "splash": background, emblem in the middle.
  const layers = elements(xml(inRes(dir, 'drawable', 'splash.xml')).documentElement, 'item');
  assert.deepEqual(
    layers.map((layer) => layer.getAttributeNS(ANDROID_NS, 'drawable')),
    ['@color/splash_background', '@mipmap/ic_launcher_foreground'],
  );
  assert.equal(layers[1].getAttributeNS(ANDROID_NS, 'gravity'), 'center');
});

test('launcher icons come from resources/android; the adaptive icon uses the background colour', () => {
  const dir = freshApp();
  configureAndroid({ root: dir });
  for (const density of Object.keys(DENSITIES)) {
    for (const name of ICON_NAMES) {
      const source = readFileSync(path.join(dir, 'resources', 'android', `mipmap-${density}`, name));
      assert.ok(readFileSync(inRes(dir, `mipmap-${density}`, name)).equals(source), `mipmap-${density}/${name}`);
    }
  }
  for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const icon = xml(inRes(dir, 'mipmap-anydpi-v26', name)).documentElement;
    assert.equal(icon.nodeName, 'adaptive-icon');
    assert.equal(elements(icon, 'background')[0].getAttributeNS(ANDROID_NS, 'drawable'), '@color/ic_launcher_background');
    assert.equal(elements(icon, 'foreground')[0].getAttributeNS(ANDROID_NS, 'drawable'), '@mipmap/ic_launcher_foreground');
  }
});

test('the placeholder art of the template is deleted, with the folders it leaves empty', () => {
  const dir = freshApp();
  for (const file of TEMPLATE_ART) assert.ok(existsSync(inRes(dir, ...file.split('/'))), `the template still has ${file}`);
  const result = configureAndroid({ root: dir });
  for (const file of TEMPLATE_ART) {
    assert.ok(!existsSync(inRes(dir, ...file.split('/'))), file);
    assert.ok(result.removed.includes(`android/app/src/main/res/${file}`), file);
  }
  assert.deepEqual(
    readdirSync(inRes(dir)).sort(),
    ['drawable', 'layout', 'mipmap-anydpi-v26', 'mipmap-hdpi', 'mipmap-mdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi', 'values', 'xml'],
  );
  assert.deepEqual(readdirSync(inRes(dir, 'drawable')), ['splash.xml']);
});

test('MainActivity moves to the folder its package needs and makes the window edge to edge', () => {
  const dir = freshApp({ appId: 'org.example.puzzle.app' });
  const before = read(inMain(dir, 'java', 'com', 'getcapacitor', 'myapp', 'MainActivity.java'));
  assert.ok(before.startsWith('package com.getcapacitor.myapp;\n'));
  assert.ok(before.includes('public class MainActivity extends BridgeActivity {}'), 'the template is an empty class');

  const result = configureAndroid({ root: dir });
  const source = read(inMain(dir, 'java', 'org', 'example', 'puzzle', 'app', 'MainActivity.java'));
  assert.deepEqual(readdirSync(inMain(dir, 'java')), ['org'], 'the template\'s com/getcapacitor/myapp folders are gone');
  assert.ok(result.removed.includes('android/app/src/main/java/com/getcapacitor/myapp/MainActivity.java'));

  const code = source.replace(/\/\/[^\n]*/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(code, [
    'package org.example.puzzle.app;',
    'import android.graphics.Color;',
    'import android.os.Bundle;',
    'import androidx.activity.EdgeToEdge;',
    'import androidx.activity.SystemBarStyle;',
    'import com.getcapacitor.BridgeActivity;',
    'public class MainActivity extends BridgeActivity {',
    '@Override',
    'protected void onCreate(Bundle savedInstanceState) {',
    'super.onCreate(savedInstanceState);',
    // Dark styles for both bars: without them EdgeToEdge follows the phone's theme, and the game is always dark.
    'EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));',
    '}',
    '}',
  ]);
  assert.ok(source.startsWith('// Written by scripts/configure-android.mjs.'), 'the file says who writes it');

  // A later change of the package name moves the file again and changes one line of it.
  writeConfig(dir, { appId: 'org.example.other' });
  configureAndroid({ root: dir });
  assert.equal(read(inMain(dir, 'java', 'org', 'example', 'other', 'MainActivity.java')), source.replace('package org.example.puzzle.app;', 'package org.example.other;'));
  assert.deepEqual(readdirSync(inMain(dir, 'java', 'org', 'example')), ['other']);
});

test('a MainActivity written by the script is put right again; one that was taken over is kept', () => {
  const dir = freshApp();
  configureAndroid({ root: dir });
  const file = inMain(dir, 'java', 'com', 'example', 'fixture', 'MainActivity.java');
  const written = read(file);

  // Still marked as the script's: an edit is undone, like in any file it writes whole.
  edit(file, (text) => text.replace(/^\s*EdgeToEdge\.enable\(.*\n/m, ''));
  assert.deepEqual(configureAndroid({ root: dir, check: true }).changed, ['android/app/src/main/java/com/example/fixture/MainActivity.java']);
  configureAndroid({ root: dir });
  assert.equal(read(file), written);

  // Taken over (the marker comment deleted) with code of the owner's: kept as it is ...
  const own = written
    .split('\n')
    .slice(3)
    .join('\n')
    .replace('super.onCreate(savedInstanceState);', 'registerPlugin(MyPlugin.class);\n        super.onCreate(savedInstanceState);');
  assert.ok(own.startsWith('package com.example.fixture;\n') && own.includes('registerPlugin(MyPlugin.class);'));
  writeFileSync(file, own);
  assert.deepEqual(configureAndroid({ root: dir }).changed, []);
  assert.equal(read(file), own);
  // ... and only its package line follows app.config.json.
  writeConfig(dir, { appId: 'com.example.renamed' });
  configureAndroid({ root: dir });
  assert.equal(read(inMain(dir, 'java', 'com', 'example', 'renamed', 'MainActivity.java')), own.replace('package com.example.fixture;', 'package com.example.renamed;'));
});

test('a MainActivity that was taken over and lost the edge-to-edge call is refused, with the line to put back', () => {
  const dir = freshApp();
  configureAndroid({ root: dir });
  const file = inMain(dir, 'java', 'com', 'example', 'fixture', 'MainActivity.java');
  const own = read(file).split('\n').slice(3).join('\n');
  for (const broken of [
    own.replace(/^\s*EdgeToEdge\.enable\(.*\n/m, ''),
    own.replace(/^(\s*)(EdgeToEdge\.enable\(.*)$/m, '$1// $2'), // commented out is gone, too
  ]) {
    assert.ok(!broken.includes('\n        EdgeToEdge.enable('), 'the fixture really lacks the call');
    writeFileSync(file, broken);
    const before = snapshot(dir);
    assert.throws(
      () => configureAndroid({ root: dir }),
      (error) => {
        assert.match(error.message, /MainActivity\.java has been changed by hand and no longer makes the window edge to edge/);
        assert.ok(error.message.includes('EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));'));
        assert.match(error.message, /It was not touched\.$/);
        return true;
      },
    );
    assert.deepEqual(snapshot(dir), before);
  }
});

test('the committed MainActivity is the one the script writes, and Capacitor still leaves edge to edge to the app', () => {
  const packageName = androidPackageName(JSON.parse(read(path.join(root, 'app.config.json'))));
  const source = read(inMain(root, 'java', ...packageName.split('.'), 'MainActivity.java'));
  assert.ok(source.startsWith('// Written by scripts/configure-android.mjs.'));
  assert.match(source, /super\.onCreate\(savedInstanceState\);\n(?:\s*\/\/[^\n]*\n)*\s*EdgeToEdge\.enable\(this, SystemBarStyle\.dark\(Color\.TRANSPARENT\), SystemBarStyle\.dark\(Color\.TRANSPARENT\)\);/);

  // Why the call is there. Read from the Capacitor that is installed, so that an update which
  // changes either fact turns this test red and the call is looked at again:
  const capacitor = path.join(root, 'node_modules', '@capacitor', 'android', 'capacitor', 'src', 'main', 'java', 'com', 'getcapacitor');
  // 1. Capacitor's own activity does not make the window edge to edge (its documentation says Capacitor 9 will).
  const bridgeActivity = read(path.join(capacitor, 'BridgeActivity.java'));
  assert.ok(!/EdgeToEdge|setDecorFitsSystemWindows|enableEdgeToEdge/.test(bridgeActivity), 'BridgeActivity now handles edge to edge itself: MainActivity\'s call may be redundant');
  assert.match(bridgeActivity, /protected void onCreate\(Bundle savedInstanceState\)/);
  // 2. SystemBars hands the page the real bar sizes whenever the WebView is 140 or newer and the page
  //    declares viewport-fit=cover, without looking at whether the window is edge to edge.
  const systemBars = read(path.join(capacitor, 'plugin', 'SystemBars.java'));
  assert.match(systemBars, /WEBVIEW_VERSION_WITH_SAFE_AREA_FIX = 140;/);
  assert.match(systemBars, /boolean shouldPassthroughInsets = getWebViewMajorVersion\(\) >= WEBVIEW_VERSION_WITH_SAFE_AREA_FIX && hasViewportCover;/);
  assert.match(systemBars, /setProperty\("--safe-area-inset-bottom", "%dpx"\)/);
  // 3. The library the call comes from is the version the project builds with.
  assert.match(read(inAndroid(root, 'variables.gradle')), /androidxActivityVersion = '1\.(?:[89]|\d\d+)\.\d+'/, 'EdgeToEdge and SystemBarStyle exist from androidx.activity 1.8.0');
});

test('a second run changes nothing, byte for byte', () => {
  const dir = freshApp();
  configureAndroid({ root: dir });
  const first = snapshot(dir);
  const second = configureAndroid({ root: dir });
  assert.deepEqual(second.changed, []);
  assert.deepEqual(second.removed, []);
  assert.deepEqual(snapshot(dir), first);
  assert.deepEqual(configureAndroid({ root: dir, check: true }).changed, []);
});

test('--check reports what is out of date, deletions included, and writes nothing', () => {
  const dir = freshApp();
  const before = snapshot(dir);
  const result = configureAndroid({ root: dir, check: true });
  assert.ok(result.changed.includes('android/app/src/main/AndroidManifest.xml'));
  assert.ok(result.changed.includes('android/app/release.gradle'));
  assert.ok(result.changed.includes('android/app/src/main/res/drawable/splash.png'), 'a file to delete counts as out of date');
  assert.equal(result.removed.length, TEMPLATE_ART.length + 1, 'the placeholder art and the template\'s MainActivity');
  assert.deepEqual(result.unchanged, []);
  assert.deepEqual(snapshot(dir), before);
});

// --- changes later on -------------------------------------------------------------------------

test('editing app.config.json and running again updates the project; nothing else moves', () => {
  const dir = freshApp();
  configureAndroid({ root: dir });
  writeConfig(dir, {
    appName: 'Other Name',
    appId: 'com.example.other',
    version: '1.2.0',
    build: 9,
    admob: { ...FIXTURE.admob, android: { ...FIXTURE.admob.android, appId: 'ca-app-pub-9999999999999999~8888888888' } },
  });
  const result = configureAndroid({ root: dir });
  assert.deepEqual(result.changed.sort(), [
    'android/app/build.gradle',
    'android/app/src/main/AndroidManifest.xml',
    'android/app/src/main/java/com/example/fixture/MainActivity.java',
    'android/app/src/main/java/com/example/other/MainActivity.java',
    'android/app/src/main/res/values/strings.xml',
  ]);
  assert.deepEqual(result.removed, ['android/app/src/main/java/com/example/fixture/MainActivity.java']);
  assert.deepEqual(readdirSync(inMain(dir, 'java', 'com', 'example')), ['other']);
  assert.ok(read(inMain(dir, 'java', 'com', 'example', 'other', 'MainActivity.java')).includes('\npackage com.example.other;\n'));

  const gradle = read(inAndroid(dir, 'app', 'build.gradle'));
  for (const text of ['namespace = "com.example.other"', 'applicationId "com.example.other"', 'versionCode 9', 'versionName "1.2.0"']) {
    assert.ok(gradle.includes(text), text);
  }
  assert.equal(gradle.split("apply from: 'release.gradle'").length - 1, 1, 'the line is not added a second time');
  assert.equal(readValues(inRes(dir, 'values', 'strings.xml'), 'string').app_name, 'Other Name');
  const manifest = readManifest(dir);
  assert.equal(manifest.metaData[ADMOB_KEY], 'ca-app-pub-9999999999999999~8888888888');
  assert.equal(manifest.metaDataCount, 1, 'the id is replaced, not added again');
  assert.deepEqual(configureAndroid({ root: dir }).changed, []);
});

test('new colours and icons in resources/android reach the project', () => {
  const dir = freshApp();
  configureAndroid({ root: dir });
  writeFileSync(path.join(dir, 'resources', 'android', 'colors.json'), JSON.stringify({ iconBackground: '#ABCDEF', splashBackground: '#010203', statusBar: '#0a0b0c' }));
  const icon = pngHeader(192, 192, 2);
  writeFileSync(path.join(dir, 'resources', 'android', 'mipmap-xxxhdpi', 'ic_launcher.png'), icon);
  const result = configureAndroid({ root: dir });
  assert.deepEqual(result.changed.sort(), [
    'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png',
    'android/app/src/main/res/values/colors.xml',
    'android/app/src/main/res/values/ic_launcher_background.xml',
  ]);
  assert.ok(readFileSync(inRes(dir, 'mipmap-xxxhdpi', 'ic_launcher.png')).equals(icon));
  assert.deepEqual(readValues(inRes(dir, 'values', 'colors.xml'), 'color'), { splash_background: '#010203', system_bar: '#0a0b0c' });
  assert.deepEqual(readValues(inRes(dir, 'values', 'ic_launcher_background.xml'), 'color'), { ic_launcher_background: '#ABCDEF' });
});

test('what was added by hand to the files the script edits in place survives', () => {
  const dir = freshApp();
  configureAndroid({ root: dir });
  edit(inMain(dir, 'AndroidManifest.xml'), (text) =>
    text.replace(
      '    <uses-permission android:name="android.permission.INTERNET" />',
      '    <uses-permission android:name="android.permission.INTERNET" />\n    <!-- added by hand -->\n    <uses-permission android:name="android.permission.CAMERA"/>',
    ),
  );
  edit(inRes(dir, 'values', 'strings.xml'), (text) => text.replace('</resources>', '    <string name="mine">Added by hand</string>\n</resources>'));
  edit(inRes(dir, 'values', 'styles.xml'), (text) =>
    text
      .replace('<item name="postSplashScreenTheme">', '<item name="windowSplashScreenAnimationDuration">200</item>\n        <item name="postSplashScreenTheme">')
      .replace('</resources>', '    <style name="Mine" parent="AppTheme"/>\n</resources>'),
  );
  edit(inAndroid(dir, 'app', 'build.gradle'), (text) => text.replace('    testImplementation', '    implementation "com.example:added-by-hand:1.0"\n    testImplementation'));
  edit(inAndroid(dir, '.gitignore'), (text) => `${text}my-notes.txt\n`);
  // MainActivity.java is written whole until its first three comment lines are deleted; from then on it is its owner's.
  edit(inMain(dir, 'java', 'com', 'example', 'fixture', 'MainActivity.java'), (text) =>
    text
      .split('\n')
      .slice(3)
      .join('\n')
      .replace('extends BridgeActivity {\n', 'extends BridgeActivity {\n    // added by hand\n    static final int ADDED = 1;\n'),
  );
  const edited = snapshot(dir);

  assert.deepEqual(configureAndroid({ root: dir }).changed, []);
  assert.deepEqual(snapshot(dir), edited);
  assert.deepEqual(readManifest(dir).permissions, ['android.permission.INTERNET', 'android.permission.CAMERA']);

  // And they are still there after a change that rewrites each of those files.
  writeConfig(dir, { appName: 'Renamed', appId: 'com.example.renamed', build: 2 });
  writeFileSync(inRes(dir, 'values', 'styles.xml'), read(inRes(dir, 'values', 'styles.xml')).replace('@color/system_bar</item>', '#000000</item>'));
  configureAndroid({ root: dir });
  assert.ok(read(inMain(dir, 'AndroidManifest.xml')).includes('    <!-- added by hand -->\n    <uses-permission android:name="android.permission.CAMERA"/>'));
  assert.equal(readValues(inRes(dir, 'values', 'strings.xml'), 'string').mine, 'Added by hand');
  assert.ok(readStyle(dir, 'AppTheme.NoActionBarLaunch').items.some(([name]) => name === 'windowSplashScreenAnimationDuration'));
  assert.equal(readStyle(dir, 'Mine').parent, 'AppTheme');
  assert.equal(readStyle(dir, 'AppTheme.NoActionBar').items.filter(([, value]) => value === '@color/system_bar').length, 3, 'the value changed by hand is put back');
  assert.ok(read(inAndroid(dir, 'app', 'build.gradle')).includes('implementation "com.example:added-by-hand:1.0"'));
  assert.ok(lines(inAndroid(dir, '.gitignore')).includes('my-notes.txt'));
  const activity = read(inMain(dir, 'java', 'com', 'example', 'renamed', 'MainActivity.java'));
  assert.ok(activity.startsWith('package com.example.renamed;\n'));
  assert.ok(activity.includes('    // added by hand\n    static final int ADDED = 1;\n'), 'the file moved with everything in it');
});

test('an AdMob app id that is already in the manifest is corrected where it stands, whatever its layout', () => {
  const dir = freshApp();
  edit(inMain(dir, 'AndroidManifest.xml'), (text) =>
    text.replace('    </application>', `        <meta-data android:value='ca-app-pub-0000000000000000~0000000000' android:name='${ADMOB_KEY}'/>\n    </application>`),
  );
  configureAndroid({ root: dir });
  assert.ok(read(inMain(dir, 'AndroidManifest.xml')).includes(`        <meta-data android:value='${FIXTURE.admob.android.appId}' android:name='${ADMOB_KEY}'/>\n    </application>`));
  assert.equal(readManifest(dir).metaDataCount, 1);
});

test('a manifest written on one line, or with Windows line endings, is edited in its own style', () => {
  const oneLine = freshApp();
  edit(inMain(oneLine, 'AndroidManifest.xml'), (text) => text.replace(/<application[^>]*>/, '<application android:label="@string/app_name" android:theme="@style/AppTheme">'));
  configureAndroid({ root: oneLine });
  assert.ok(
    read(inMain(oneLine, 'AndroidManifest.xml')).includes(
      '<application android:label="@string/app_name" android:theme="@style/AppTheme" android:usesCleartextTraffic="false" android:appCategory="game">',
    ),
  );

  const windows = freshApp();
  for (const file of [inMain(windows, 'AndroidManifest.xml'), inRes(windows, 'values', 'strings.xml'), inRes(windows, 'values', 'styles.xml'), inAndroid(windows, 'app', 'build.gradle'), inAndroid(windows, '.gitignore')]) {
    edit(file, (text) => text.replace(/\r?\n/g, '\r\n'));
  }
  configureAndroid({ root: windows });
  for (const file of [inMain(windows, 'AndroidManifest.xml'), inRes(windows, 'values', 'strings.xml'), inRes(windows, 'values', 'styles.xml'), inAndroid(windows, 'app', 'build.gradle'), inAndroid(windows, '.gitignore')]) {
    assert.ok(!/(^|[^\r])\n/.test(read(file)), `${path.basename(file)} has only Windows line endings`);
  }
  assert.equal(readManifest(windows).metaData[ADMOB_KEY], FIXTURE.admob.android.appId);
  assert.ok(read(inAndroid(windows, 'app', 'build.gradle')).includes(`applicationId "${FIXTURE.appId}"\r\n`));
  assert.deepEqual(configureAndroid({ root: windows }).changed, []);
});

test('a name with quotes, an ampersand or a leading @ is shown by Android exactly as written', () => {
  for (const name of ['Tom\'s "First" & <Come>', '@home \\ away', '?', 'Ünïcødé 游戏']) {
    const dir = freshApp({ appName: name });
    configureAndroid({ root: dir });
    const stored = readValues(inRes(dir, 'values', 'strings.xml'), 'string').app_name;
    assert.equal(stored, androidString(name));
    assert.equal(shownByAndroid(stored), name);
    assert.deepEqual(configureAndroid({ root: dir }).changed, [], name);
  }
  assert.equal(androidString('Tom\'s "First" & <Come>'), 'Tom\\\'s \\"First\\" & <Come>');
  assert.equal(androidString('@home \\ away'), '\\@home \\\\ away');
  assert.equal(androidString('plain @ ? inside'), 'plain @ ? inside');
});

// --- refusing to guess ------------------------------------------------------------------------

test('a manifest the script does not fully understand is refused, and nothing at all is written', () => {
  const cases = [
    [(text) => text.replace('</activity>', ''), /closing tag that closes nothing/],
    [(text) => text.replace('<manifest', '<!DOCTYPE manifest>\n<manifest'), /DOCTYPE/],
    [(text) => text.replace('android:name=".MainActivity"', 'android:name=".OtherActivity"'), /exactly one <activity android:name="\.MainActivity">/],
    [(text) => text.replace('</manifest>', '<application/>\n</manifest>'), /exactly one <application>/],
    [(text) => text.replace('android:supportsRtl="true"', 'android:supportsRtl="true" android:supportsRtl="false"'), /sets android:supportsRtl twice/],
    [(text) => text.replace('@string/app_name', 'Fish &chips'), /an & that does not start an entity/],
    [(text) => text.replace('<manifest xmlns:android="http://schemas.android.com/apk/res/android">', '<manifest>'), /not an Android manifest/],
    [
      (text) => text.replace('    </application>', `        <meta-data android:name="${ADMOB_KEY}" android:value="a"/>\n        <meta-data android:name="${ADMOB_KEY}" android:value="b"/>\n    </application>`),
      /has 2 <meta-data android:name="com\.google\.android\.gms\.ads\.APPLICATION_ID"> elements/,
    ],
  ];
  for (const [damage, message] of cases) {
    const dir = freshApp();
    edit(inMain(dir, 'AndroidManifest.xml'), damage);
    const before = snapshot(dir);
    assert.throws(() => configureAndroid({ root: dir }), (error) => message.test(error.message) && error.message.includes('AndroidManifest.xml'), String(message));
    assert.deepEqual(snapshot(dir), before, `nothing was written (${message})`);
  }
});

test('a build file that is not Capacitor\'s is refused with an explanation', () => {
  const cases = [
    [(text) => text.replace('        versionCode 1\n', ''), /exactly one "versionCode" line and found 0/],
    [(text) => text.replace('        applicationId "com.getcapacitor.app"', '        applicationId "a.b"\n        applicationId "c.d"'), /exactly one "applicationId" line and found 2/],
    [(text) => text.replace('versionName "1.0"', 'versionName rootProject.ext.versionName'), /exactly one "versionName" line and found 0/],
    [(text) => text.replace("apply from: 'capacitor.build.gradle'", ''), /exactly one "apply from: 'capacitor\.build\.gradle'" line and found 0/],
  ];
  for (const [damage, message] of cases) {
    const dir = freshApp();
    edit(inAndroid(dir, 'app', 'build.gradle'), damage);
    const before = snapshot(dir);
    assert.throws(() => configureAndroid({ root: dir }), (error) => message.test(error.message) && error.message.includes('npx cap add android'), String(message));
    assert.deepEqual(snapshot(dir), before);
  }
});

test('a MainActivity or a styles file changed beyond recognition is refused', () => {
  const activity = freshApp();
  configureAndroid({ root: activity });
  edit(inMain(activity, 'java', 'com', 'example', 'fixture', 'MainActivity.java'), (text) => text.replace('extends BridgeActivity', 'extends Activity'));
  const before = snapshot(activity);
  assert.throws(() => configureAndroid({ root: activity }), /MainActivity\.java is not the MainActivity that Capacitor creates/);
  assert.deepEqual(snapshot(activity), before);

  const styles = freshApp();
  edit(inRes(styles, 'values', 'styles.xml'), (text) => text.replace('name="AppTheme.NoActionBarLaunch"', 'name="AppTheme.Launch"'));
  assert.throws(() => configureAndroid({ root: styles }), /styles\.xml: has no <style name="AppTheme\.NoActionBarLaunch">/);

  const twice = freshApp();
  mkdirSync(inMain(twice, 'java', 'other'), { recursive: true });
  writeFileSync(inMain(twice, 'java', 'other', 'MainActivity.java'), 'package other;\n');
  assert.throws(() => configureAndroid({ root: twice }), /2 files called MainActivity\.java/);
});

test('without an Android project the script says how to create one', () => {
  const empty = path.join(scratch, 'no-platform');
  mkdirSync(empty, { recursive: true });
  assert.throws(() => configureAndroid({ root: empty }), /npx cap add android/);

  const partial = freshApp();
  rmSync(inRes(partial, 'values', 'styles.xml'));
  assert.throws(() => configureAndroid({ root: partial }), /is missing android\/app\/src\/main\/res\/values\/styles\.xml/);
});

test('mistakes in app.config.json are all listed, in plain words; iPhone-only settings are not asked for', () => {
  const dir = freshApp({
    appId: 'com.your-name.new',
    appName: ' Two  lines\nhere',
    version: 'one',
    build: 0,
    admob: { testing: true, android: { ...FIXTURE.admob.android, appId: 'ca-app-pub-1111111111111111/2222222222' } },
  });
  const before = snapshot(dir);
  assert.throws(
    () => configureAndroid({ root: dir }),
    (error) => {
      for (const word of ['"appId"', '"appName"', '"version"', '"build"', '"admob.android.appId"', 'no hyphens']) assert.ok(error.message.includes(word), word);
      for (const word of ['admob.ios', 'trackingUsageDescription']) assert.ok(!error.message.includes(word), word);
      return true;
    },
  );
  assert.deepEqual(snapshot(dir), before);

  for (const appId of ['single', 'com.example.1game', 'com.example.public', 'com..example', 'com.example.']) {
    writeConfig(dir, { appId });
    assert.throws(() => configureAndroid({ root: dir }), /"appId" must be an Android package name/, appId);
  }
  // Where a name Android accepts is one obvious step away, the message offers it.
  writeConfig(dir, { appId: 'com.your-name.new' });
  assert.throws(() => configureAndroid({ root: dir }), /or keep "appId" for iPhone and give Android a name of its own in a second field, for example "androidAppId": "com\.your_name\.new_"/);
  writeConfig(dir, { appId: 'com.example.1game' });
  assert.throws(() => configureAndroid({ root: dir }), /in a second field, "androidAppId"$/m);
  writeConfig(dir, { build: 2100000001 });
  assert.throws(() => configureAndroid({ root: dir }), /"build" must be a whole number from 1 to 2100000000/);
  writeFileSync(path.join(dir, 'app.config.json'), '{ not json');
  assert.throws(() => configureAndroid({ root: dir }), /Cannot read app\.config\.json/);
});

test('an iPhone bundle id that Android cannot take does not block Android: "androidAppId" names the package', () => {
  // A hyphen is fine for Apple and impossible in an Android package name.
  const dir = freshApp({ appId: 'com.your-name.first-come', androidAppId: 'com.your_name.firstcome' });
  const result = configureAndroid({ root: dir });
  assert.match(result.summary, /^Fixture App \(com\.your_name\.firstcome\) /);

  const gradle = lines(inAndroid(dir, 'app', 'build.gradle')).map((line) => line.trim());
  assert.ok(gradle.includes('namespace = "com.your_name.firstcome"'));
  assert.ok(gradle.includes('applicationId "com.your_name.firstcome"'));
  const strings = readValues(inRes(dir, 'values', 'strings.xml'), 'string');
  assert.equal(strings.package_name, 'com.your_name.firstcome');
  assert.equal(strings.custom_url_scheme, 'com.your_name.firstcome');
  assert.ok(read(inMain(dir, 'java', 'com', 'your_name', 'firstcome', 'MainActivity.java')).includes('\npackage com.your_name.firstcome;\n'));
  // The iPhone id is nowhere in the Android project.
  for (const [file, content] of snapshot(dir)) {
    assert.ok(!Buffer.from(content, 'base64').includes('com.your-name.first-come'), file);
  }
  assert.deepEqual(configureAndroid({ root: dir, check: true }).changed, []);

  assert.equal(androidPackageName({ appId: 'a.b', androidAppId: 'c.d' }), 'c.d');
  assert.equal(androidPackageName({ appId: 'a.b' }), 'a.b');

  // The field has to be a package name itself, whatever "appId" is; it is not repaired silently.
  for (const androidAppId of ['com.your-name.firstcome', 'firstcome', 'com.example.new', '', null, 7]) {
    writeConfig(dir, { appId: 'com.example.fine', androidAppId });
    const before = snapshot(dir);
    assert.throws(() => configureAndroid({ root: dir }), /"androidAppId" must be an Android package name[\s\S]*Leave the field out to use "appId" on Android as well/, String(androidAppId));
    assert.deepEqual(snapshot(dir), before);
  }
});

test('art that would give a broken icon stops the run before anything is written', () => {
  const dir = freshApp();
  const before = snapshot(dir);
  const resource = (...parts) => path.join(dir, 'resources', 'android', ...parts);
  const original = readFileSync(resource('mipmap-hdpi', 'ic_launcher_foreground.png'));

  writeFileSync(resource('mipmap-hdpi', 'ic_launcher_foreground.png'), pngHeader(162, 162, 2)); // 2 = RGB, no alpha
  assert.throws(() => configureAndroid({ root: dir }), /mipmap-hdpi\/ic_launcher_foreground\.png has no transparency/);
  writeFileSync(resource('mipmap-hdpi', 'ic_launcher_foreground.png'), pngHeader(108, 108, 6));
  assert.throws(() => configureAndroid({ root: dir }), /is 108 x 108; it must be 162 x 162/);
  writeFileSync(resource('mipmap-hdpi', 'ic_launcher_foreground.png'), 'not an image');
  assert.throws(() => configureAndroid({ root: dir }), /not a PNG/);
  rmSync(resource('mipmap-hdpi', 'ic_launcher_foreground.png'));
  assert.throws(() => configureAndroid({ root: dir }), /only some of the launcher icons\. Missing: mipmap-hdpi\/ic_launcher_foreground\.png/);
  writeFileSync(resource('mipmap-hdpi', 'ic_launcher_foreground.png'), original);

  writeFileSync(resource('colors.json'), JSON.stringify({ ...COLOURS, statusBar: 'navy' }));
  assert.throws(() => configureAndroid({ root: dir }), /"statusBar" must be a colour written as #RRGGBB/);
  rmSync(resource('colors.json'));
  assert.throws(() => configureAndroid({ root: dir }), /colors\.json[\s\S]*npm run art/);
  assert.deepEqual(snapshot(dir), before);
});

test('without launcher icons in resources/android the icons already in the project are kept', () => {
  const dir = freshApp();
  for (const density of Object.keys(DENSITIES)) rmSync(path.join(dir, 'resources', 'android', `mipmap-${density}`), { recursive: true });
  const before = readFileSync(inRes(dir, 'mipmap-xhdpi', 'ic_launcher.png'));
  const result = configureAndroid({ root: dir });
  assert.ok(readFileSync(inRes(dir, 'mipmap-xhdpi', 'ic_launcher.png')).equals(before));
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /launcher icons already in the project are kept/);
  assert.ok(!result.changed.some((file) => file.endsWith('.png') && file.includes('/mipmap-')));
});

test('a target API level below what Google Play accepts is pointed out', () => {
  const dir = freshApp();
  assert.deepEqual(configureAndroid({ root: dir, check: true }).notes, [], 'the template of this Capacitor version is recent enough');
  edit(inAndroid(dir, 'variables.gradle'), (text) => text.replace(/targetSdkVersion = \d+/, 'targetSdkVersion = 35'));
  const result = configureAndroid({ root: dir });
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /targets Android API level 35\. Google Play only accepts new apps and updates that target 36 or higher/);
  assert.match(result.summary, /targets Android API 35/);
});

test('settings in capacitor.config.ts that would fight the themes are pointed out, once cap sync has copied them', () => {
  const dir = freshApp();
  const synced = inMain(dir, 'assets', 'capacitor.config.json');
  const withPlugins = (plugins) => {
    mkdirSync(path.dirname(synced), { recursive: true });
    writeFileSync(synced, JSON.stringify({ appId: FIXTURE.appId, plugins }));
    return configureAndroid({ root: dir }).notes;
  };
  assert.deepEqual(configureAndroid({ root: dir }).notes, [], 'before the first cap sync there is nothing to compare');
  assert.deepEqual(withPlugins({ SystemBars: { style: 'DARK' }, SplashScreen: { launchAutoHide: true, launchShowDuration: 5000 } }), []);
  assert.deepEqual(withPlugins({ SystemBars: { style: 'dark' } }), [], 'Capacitor reads the value in any case');

  for (const plugins of [{}, { SystemBars: {} }, { SystemBars: { style: 'LIGHT' } }, { SystemBars: { style: 'DEFAULT' } }]) {
    const notes = withPlugins(plugins);
    assert.equal(notes.length, 1, JSON.stringify(plugins));
    assert.match(notes[0], /plugins\.SystemBars\.style to 'DARK'/);
  }
  const notes = withPlugins({ SystemBars: { style: 'DARK' }, SplashScreen: { androidSplashResourceName: 'launch' } });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /androidSplashResourceName to "launch"[\s\S]*res\/drawable\/splash\.xml/);

  writeFileSync(synced, '{ half a file');
  assert.deepEqual(configureAndroid({ root: dir }).notes, [], 'an unreadable copy is cap sync\'s to repair, not a reason to stop');
});

// --- how the script is wired in ---------------------------------------------------------------

test('npm run sync checks both platforms before it writes anything, then: bridge, cap sync for each, both configure scripts', () => {
  const scripts = JSON.parse(read(path.join(root, 'package.json'))).scripts;
  const steps = scripts.sync.split('&&').map((step) => step.trim());
  assert.deepEqual(steps, [
    'node scripts/check-config.mjs',
    'npm run build:bridge',
    'cap sync ios',
    'cap sync android',
    'node scripts/configure-ios.mjs',
    'node scripts/configure-android.mjs',
  ]);
  assert.equal(scripts['configure:android'], 'node scripts/configure-android.mjs');
  assert.equal(scripts['check:config'], 'node scripts/check-config.mjs');
});

test('the release workflow hands the build the very names that release.gradle reads', () => {
  const release = read(inAndroid(root, 'app', 'release.gradle'));
  const workflow = read(path.join(root, 'ci', 'android-release.yml'));
  const read_by_build = [...release.matchAll(/'(ANDROID_[A-Z_]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(read_by_build)].sort(), [
    'ANDROID_KEYSTORE_FILE',
    'ANDROID_KEYSTORE_PASSWORD',
    'ANDROID_KEY_ALIAS',
    'ANDROID_KEY_PASSWORD',
    'ANDROID_VERSION_CODE',
  ]);
  // Given to the build as environment variables: one through $GITHUB_ENV, one for the whole job,
  // three on the build step.
  assert.ok(workflow.includes('echo "ANDROID_KEYSTORE_FILE=$keystore" >> "$GITHUB_ENV"'));
  for (const name of ['ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']) {
    assert.ok(workflow.includes(`${name}: \${{ secrets.${name} }}`), name);
  }
  assert.ok(workflow.includes('ANDROID_VERSION_CODE: ${{ env.VERSION_CODE }}'));
  // And the templates still carry their placeholders: the filled-in copies live in .github/workflows.
  assert.ok(workflow.includes('APP_DIR: __APP_DIR__'));
  const build = read(path.join(root, 'ci', 'android-build.yml'));
  assert.ok(build.includes('APP_DIR: __APP_DIR__') && build.includes('WEB_DIR: __WEB_DIR__'));
});

/** The JavaScript of a workflow step that runs `node -e '...'`, as GitHub would hand it to node. */
function nodeScriptOfStep(workflow, stepName) {
  const step = workflow.slice(workflow.indexOf(`- name: ${stepName}\n`));
  const found = /\n( +)node -e '\n([\s\S]*?)\n\1'\n/.exec(step);
  assert.ok(found, `the step "${stepName}" runs node -e with its script on the lines that follow`);
  assert.ok(!found[2].includes("'"), 'the script sits inside single quotes in the shell, so it has none of its own');
  return found[2];
}

test('the release workflow refuses a bundle with a placeholder package name, or without testing but with Google\'s sample advert ids', () => {
  const script = nodeScriptOfStep(read(path.join(root, 'ci', 'android-release.yml')), 'Check app.config.json');
  const dir = path.join(scratch, 'release-check');
  mkdirSync(dir, { recursive: true });
  const run = (config) => {
    writeFileSync(path.join(dir, 'app.config.json'), JSON.stringify(config));
    try {
      return { status: 0, output: execFileSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8', env: { ...process.env, VERSION_CODE: '7' } }) };
    } catch (error) {
      return { status: error.status, output: String(error.stdout) };
    }
  };
  const real = FIXTURE.admob.android;
  const sample = {
    appId: 'ca-app-pub-3940256099942544~3347511713',
    banner: 'ca-app-pub-3940256099942544/9214589741',
    interstitial: 'ca-app-pub-3940256099942544/1033173712',
    rewarded: 'ca-app-pub-3940256099942544/5224354917',
  };
  const config = (changes = {}) => ({ ...FIXTURE, appId: 'org.fixture.game', ...changes });

  // Ready for release: real ids, testing off. One line, no warning.
  assert.deepEqual(run(config({ admob: { testing: false, android: real } })), { status: 0, output: 'Fixture App (org.fixture.game) 1.0.0, version code 7\n' });

  // For testers: demo adverts, said out loud, and the build goes on (sample ids or real ones).
  for (const android of [sample, real]) {
    const testers = run(config({ admob: { testing: true, android } }));
    assert.equal(testers.status, 0);
    assert.match(testers.output, /^::warning::admob\.testing is true/);
  }

  // Meant for release, but sample ids are still in place: it would earn nothing. Stopped, and each id is named.
  const forgotten = run(config({ admob: { testing: false, android: sample } }));
  assert.equal(forgotten.status, 1);
  assert.match(forgotten.output, /^::error::admob\.testing is false, but under admob\.android these are still missing or Google sample ids: appId, banner, interstitial, rewarded\./);
  assert.ok(!forgotten.output.includes('version code'), 'nothing after the error');
  const one = run(config({ admob: { testing: false, android: { ...real, rewarded: sample.rewarded } } }));
  assert.equal(one.status, 1);
  assert.match(one.output, /Google sample ids: rewarded\./);
  const none = run(config({ admob: { testing: false } }));
  assert.equal(none.status, 1);
  assert.match(none.output, /appId, banner, interstitial, rewarded\./);
  // The iPhone ids are not this workflow's business.
  assert.equal(run(config({ admob: { testing: false, android: real, ios: sample } })).status, 0);

  // The placeholder package name, wherever the Android package name comes from.
  for (const changes of [{ appId: 'com.example.app' }, { appId: 'org.fixture-co.game', androidAppId: 'com.example.app' }]) {
    const placeholder = run(config({ ...changes, admob: { testing: false, android: real } }));
    assert.equal(placeholder.status, 1);
    assert.match(placeholder.output, /^::error::app\.config\.json still has the placeholder package name "com\.example\.app"/);
  }
  assert.match(
    run(config({ appId: 'com.example-co.game', androidAppId: 'org.fixture.game', admob: { testing: false, android: real } })).output,
    /^Fixture App \(org\.fixture\.game\) /,
  );

  // The sample ids this test uses are the ones the bridge knows as Google's (src/bridge/config.ts).
  const bridgeConfig = read(path.join(root, 'src', 'bridge', 'config.ts'));
  assert.ok(bridgeConfig.includes("export const GOOGLE_DEMO_PUBLISHER = 'ca-app-pub-3940256099942544';"));
  assert.ok(script.includes('"ca-app-pub-3940256099942544"'));
});

test('both workflows take the package name of the built app from "androidAppId" where there is one', () => {
  for (const name of ['android-build.yml', 'android-release.yml']) {
    const workflow = read(path.join(root, 'ci', name));
    assert.ok(workflow.includes(`package_name="$(config 'c.androidAppId || c.appId')"`), name);
    assert.ok(workflow.includes("package: name='$package_name' versionCode="), name);
    const withoutComments = workflow.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    assert.ok(!/config c\.appId\b/.test(withoutComments), `${name} does not read "appId" alone anywhere`);
  }
});

// --- the things these tests stand on ------------------------------------------------------------

test('the template archive these tests unpack is the one `cap add android` uses, and has what the script expects', () => {
  assert.ok(existsSync(template), 'node_modules/@capacitor/cli/assets/android-template.tar.gz');
  const dir = freshApp();
  assert.ok(read(inAndroid(dir, 'app', 'build.gradle')).includes('namespace = "com.getcapacitor.myapp"'));
  assert.ok(existsSync(inMain(dir, 'java', 'com', 'getcapacitor', 'myapp', 'MainActivity.java')));
  assert.equal(readStyle(dir, 'AppTheme.NoActionBarLaunch').parent, 'Theme.SplashScreen');
});

test('the launcher icons in resources/android have the sizes Android expects', () => {
  for (const [density, [legacy, foreground]] of Object.entries(DENSITIES)) {
    for (const name of ICON_NAMES) {
      const png = readFileSync(path.join(root, 'resources', 'android', `mipmap-${density}`, name));
      const size = name === 'ic_launcher_foreground.png' ? foreground : legacy;
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [size, size], `mipmap-${density}/${name}`);
    }
  }
});
