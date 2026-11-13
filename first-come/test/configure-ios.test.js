// scripts/configure-ios.mjs: app.config.json and resources/ applied to the Xcode project.
//
// Most tests run the script on a fresh copy of Capacitor's own iOS template (the archive the
// CLI unpacks for `cap add ios`) in a temporary folder, so they prove the whole path from a
// newly added platform. Nothing here needs a Mac.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import plist from 'plist';
import xcode from 'xcode';
import { configureIos, toPlistXml } from '../scripts/configure-ios.mjs';
import { extractIdentifiers, GOOGLE_ID } from '../scripts/update-skadnetwork.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = path.join(root, 'node_modules', '@capacitor', 'cli', 'assets', 'ios-spm-template.tar.gz');
const realConfig = JSON.parse(readFileSync(path.join(root, 'app.config.json'), 'utf8'));
const skAdNetwork = JSON.parse(readFileSync(path.join(root, 'resources', 'skadnetwork-ids.json'), 'utf8'));

const scratch = mkdtempSync(path.join(os.tmpdir(), 'configure-ios-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

/** A temporary app folder: Capacitor's untouched iOS template, the real resources/, and a config. */
function freshApp(configOverrides = {}) {
  counter += 1;
  const dir = path.join(scratch, `app-${counter}`);
  mkdirSync(path.join(dir, 'ios'), { recursive: true });
  execFileSync('tar', ['-xzf', template, '-C', path.join(dir, 'ios')]);
  cpSync(path.join(root, 'resources'), path.join(dir, 'resources'), { recursive: true });
  writeConfig(dir, configOverrides);
  return dir;
}

function writeConfig(dir, overrides) {
  writeFileSync(path.join(dir, 'app.config.json'), JSON.stringify({ ...realConfig, ...overrides }, null, 2));
}

const pbxprojOf = (dir) => path.join(dir, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const infoPlistOf = (dir) => path.join(dir, 'ios', 'App', 'App', 'Info.plist');
const readInfo = (dir) => plist.parse(readFileSync(infoPlistOf(dir), 'utf8'));
const unquote = (value) => String(value).replace(/^"(.*)"$/, '$1');

/** The app target's build settings, one object per build configuration (Debug, Release). */
function targetSettings(dir) {
  const project = xcode.project(pbxprojOf(dir)).parseSync();
  const objects = project.hash.project.objects;
  const target = Object.values(objects.PBXNativeTarget).find((t) => typeof t === 'object');
  return objects.XCConfigurationList[target.buildConfigurationList].buildConfigurations.map(
    (ref) => objects.XCBuildConfiguration[ref.value].buildSettings,
  );
}

/** Every file under ios/ with its content, to compare the project before and after a run. */
function snapshot(dir) {
  const files = new Map();
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(path.relative(dir, full), readFileSync(full).toString('base64'));
    }
  };
  walk(path.join(dir, 'ios'));
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

test('the Xcode project in ios/ is in step with app.config.json and resources/', () => {
  const result = configureIos({ root, check: true });
  assert.deepEqual(
    result.changed,
    [],
    'These files are out of date. Run `npm run sync` and commit the result (never edit them by hand).',
  );
  assert.ok(result.unchanged.length >= 5);
});

// --- from a freshly added platform ------------------------------------------------------------

test('a fresh template gets every setting from app.config.json', () => {
  const dir = freshApp({
    appId: 'com.example.first-come',
    appName: 'First & Last <Come>',
    version: '2.3.1',
    build: 47,
  });
  const result = configureIos({ root: dir });
  assert.ok(result.changed.includes('ios/App/App/Info.plist'));
  assert.ok(result.changed.includes('ios/App/App.xcodeproj/project.pbxproj'));

  const info = readInfo(dir);
  assert.equal(info.CFBundleDisplayName, 'First & Last <Come>');
  assert.equal(info.CFBundleShortVersionString, '$(MARKETING_VERSION)');
  assert.equal(info.CFBundleVersion, '$(CURRENT_PROJECT_VERSION)');
  assert.equal(info.GADApplicationIdentifier, realConfig.admob.ios.appId);
  assert.equal(info.NSUserTrackingUsageDescription, realConfig.trackingUsageDescription);
  assert.equal(info.ITSAppUsesNonExemptEncryption, false);
  assert.deepEqual(info.UISupportedInterfaceOrientations, ['UIInterfaceOrientationPortrait']);
  assert.equal(info['UISupportedInterfaceOrientations~ipad'], undefined);
  assert.deepEqual(info.UIRequiredDeviceCapabilities, ['arm64']);
  assert.equal(info.UIUserInterfaceStyle, 'Dark');
  assert.deepEqual(
    info.SKAdNetworkItems,
    skAdNetwork.identifiers.map((id) => ({ SKAdNetworkIdentifier: id })),
  );
  // What the template needs to start is still there.
  assert.equal(info.UILaunchStoryboardName, 'LaunchScreen');
  assert.equal(info.UIMainStoryboardFile, 'Main');
  assert.equal(info.CAPACITOR_DEBUG, '$(CAPACITOR_DEBUG)');
  assert.ok(info.UIApplicationSceneManifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication.length === 1);

  const settings = targetSettings(dir);
  assert.equal(settings.length, 2, 'Debug and Release');
  for (const buildSettings of settings) {
    assert.equal(buildSettings.PRODUCT_BUNDLE_IDENTIFIER, '"com.example.first-come"', 'a hyphen needs quotes in a pbxproj');
    assert.equal(buildSettings.MARKETING_VERSION, '2.3.1');
    assert.equal(buildSettings.CURRENT_PROJECT_VERSION, 47);
    assert.equal(buildSettings.TARGETED_DEVICE_FAMILY, 1);
    assert.equal(buildSettings.CODE_SIGN_STYLE, 'Automatic');
    assert.equal(buildSettings.DEVELOPMENT_TEAM, undefined, 'no team unless one is configured');
    assert.equal(unquote(buildSettings.INFOPLIST_FILE), 'App/Info.plist');
  }
});

test('a second run changes nothing, byte for byte', () => {
  const dir = freshApp();
  configureIos({ root: dir });
  const first = snapshot(dir);
  const second = configureIos({ root: dir });
  assert.deepEqual(second.changed, []);
  assert.deepEqual(snapshot(dir), first);
  assert.deepEqual(configureIos({ root: dir, check: true }).changed, []);
});

test('--check reports what is out of date and writes nothing', () => {
  const dir = freshApp();
  const before = snapshot(dir);
  const result = configureIos({ root: dir, check: true });
  assert.ok(result.changed.length >= 5);
  assert.deepEqual(snapshot(dir), before);
});

test('the project file only gains what was asked for', () => {
  const dir = freshApp();
  const before = readFileSync(pbxprojOf(dir), 'utf8').split('\n');
  configureIos({ root: dir });
  const after = readFileSync(pbxprojOf(dir), 'utf8').split('\n');

  const removed = before.filter((line) => !after.includes(line)).map((line) => line.trim());
  const added = after.filter((line) => !before.includes(line)).map((line) => line.trim());
  assert.deepEqual([...new Set(removed)].sort(), [
    'MARKETING_VERSION = 1.0;',
    'PRODUCT_BUNDLE_IDENTIFIER = com.getcapacitor.App;',
    'TARGETED_DEVICE_FAMILY = "1,2";',
  ]);
  const settingLines = [...new Set(added.filter((line) => /^[A-Z_]+ = /.test(line)))].sort();
  assert.deepEqual(settingLines, [
    `MARKETING_VERSION = ${realConfig.version};`,
    `PRODUCT_BUNDLE_IDENTIFIER = ${realConfig.appId};`,
    'TARGETED_DEVICE_FAMILY = 1;',
  ]);
  const others = added.filter((line) => !/^[A-Z_]+ = /.test(line));
  assert.equal(others.length, 6, others.join('\n'));
  assert.ok(others.every((line) => line.includes('PrivacyInfo.xcprivacy') || line.includes('Products.storekit')));
  // The template writes this number with a leading zero, which the parser alone would drop.
  assert.ok(after.some((line) => line.trim() === 'LastUpgradeCheck = 0920;'));
});

test('the privacy manifest is a resource of the app; the StoreKit file is only listed', () => {
  const dir = freshApp();
  configureIos({ root: dir });
  const objects = xcode.project(pbxprojOf(dir)).parseSync().hash.project.objects;
  const fileId = (name) =>
    Object.entries(objects.PBXFileReference).find(([, ref]) => typeof ref === 'object' && unquote(ref.path) === name)?.[0];
  const resourcePhase = Object.values(objects.PBXResourcesBuildPhase).find((phase) => typeof phase === 'object');
  const resources = resourcePhase.files.map((ref) => objects.PBXBuildFile[ref.value].fileRef);

  assert.ok(fileId('PrivacyInfo.xcprivacy'));
  assert.ok(resources.includes(fileId('PrivacyInfo.xcprivacy')));
  assert.ok(fileId('Products.storekit'));
  assert.ok(!resources.includes(fileId('Products.storekit')), 'the test product must not ship inside the app');

  const manifest = plist.parse(readFileSync(path.join(dir, 'ios', 'App', 'App', 'PrivacyInfo.xcprivacy'), 'utf8'));
  assert.deepEqual(manifest, {
    NSPrivacyAccessedAPITypes: [
      { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
    ],
    NSPrivacyCollectedDataTypes: [],
    NSPrivacyTracking: false,
    NSPrivacyTrackingDomains: [],
  });
});

test('the StoreKit test file holds the Remove Ads product, and the shared scheme uses it', () => {
  const dir = freshApp({ iap: { removeAdsProductId: 'com.example.game.noads' } });
  configureIos({ root: dir });

  const storekit = JSON.parse(readFileSync(path.join(dir, 'ios', 'App', 'Products.storekit'), 'utf8'));
  assert.deepEqual(Object.keys(storekit), ['identifier', 'nonRenewingSubscriptions', 'products', 'settings', 'subscriptionGroups', 'version']);
  assert.equal(storekit.products.length, 1);
  assert.equal(storekit.products[0].productID, 'com.example.game.noads');
  assert.equal(storekit.products[0].type, 'NonConsumable');
  assert.match(storekit.products[0].internalID, /^[0-9A-F]{8}$/);
  assert.match(storekit.identifier, /^[0-9A-F]{8}$/);

  const scheme = readFileSync(path.join(dir, 'ios', 'App', 'App.xcodeproj', 'xcshareddata', 'xcschemes', 'App.xcscheme'), 'utf8');
  const objects = xcode.project(pbxprojOf(dir)).parseSync().hash.project.objects;
  const targetId = Object.keys(objects.PBXNativeTarget).find((key) => !key.endsWith('_comment'));
  assert.equal(scheme.split(`BlueprintIdentifier = "${targetId}"`).length - 1, 3, 'build, run and profile all point at the app target');
  assert.ok(scheme.includes('BuildableName = "App.app"'));
  assert.ok(scheme.includes('ReferencedContainer = "container:App.xcodeproj"'));
  // Relative to the scheme file's folder inside App.xcodeproj: next to App.xcodeproj.
  assert.ok(scheme.includes('identifier = "../../Products.storekit"'));
  assert.ok(scheme.endsWith('</Scheme>\n'));
});

test('icon and launch image come from resources/, under the file names the template uses', () => {
  const dir = freshApp();
  const assets = path.join(dir, 'ios', 'App', 'App', 'Assets.xcassets');
  const contentsBefore = ['AppIcon.appiconset', 'Splash.imageset'].map((set) => readFileSync(path.join(assets, set, 'Contents.json'), 'utf8'));
  configureIos({ root: dir });

  const icon = readFileSync(path.join(root, 'resources', 'icon-1024.png'));
  const splash = readFileSync(path.join(root, 'resources', 'splash-2732.png'));
  assert.ok(readFileSync(path.join(assets, 'AppIcon.appiconset', 'AppIcon-512@2x.png')).equals(icon));
  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    assert.ok(readFileSync(path.join(assets, 'Splash.imageset', name)).equals(splash), name);
  }
  const contentsAfter = ['AppIcon.appiconset', 'Splash.imageset'].map((set) => readFileSync(path.join(assets, set, 'Contents.json'), 'utf8'));
  assert.deepEqual(contentsAfter, contentsBefore, 'Contents.json is the template\'s, untouched');
  assert.deepEqual(readdirSync(path.join(assets, 'Splash.imageset')).length, 4);
});

test('without art in resources/ the images already in the project are kept', () => {
  const dir = freshApp();
  rmSync(path.join(dir, 'resources', 'icon-1024.png'));
  rmSync(path.join(dir, 'resources', 'splash-2732.png'));
  const iconPath = path.join(dir, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png');
  const before = readFileSync(iconPath);
  const result = configureIos({ root: dir });
  assert.ok(readFileSync(iconPath).equals(before));
  assert.equal(result.notes.length, 2);
});

test('an icon the App Store would reject stops the run before anything is written', () => {
  const dir = freshApp();
  const before = snapshot(dir);
  writeFileSync(path.join(dir, 'resources', 'icon-1024.png'), pngHeader(1024, 1024, 6)); // 6 = RGB with alpha
  assert.throws(() => configureIos({ root: dir }), /alpha channel/);
  writeFileSync(path.join(dir, 'resources', 'icon-1024.png'), pngHeader(512, 512, 2));
  assert.throws(() => configureIos({ root: dir }), /must be 1024 x 1024/);
  writeFileSync(path.join(dir, 'resources', 'icon-1024.png'), 'not an image');
  assert.throws(() => configureIos({ root: dir }), /not a PNG/);
  assert.deepEqual(snapshot(dir), before);
});

// --- changes later on -------------------------------------------------------------------------

test('editing app.config.json and running again updates the project; nothing else moves', () => {
  const dir = freshApp();
  configureIos({ root: dir });
  // A name and id that no real app.config.json will hold, so the edit is always a change.
  writeConfig(dir, { appName: 'Renamed Game', appId: 'com.example.renamed', version: '1.2.0', build: 9 });
  const result = configureIos({ root: dir });
  assert.deepEqual(result.changed.sort(), ['ios/App/App.xcodeproj/project.pbxproj', 'ios/App/App/Info.plist']);
  assert.equal(readInfo(dir).CFBundleDisplayName, 'Renamed Game');
  for (const buildSettings of targetSettings(dir)) {
    assert.equal(buildSettings.PRODUCT_BUNDLE_IDENTIFIER, 'com.example.renamed');
    assert.equal(buildSettings.MARKETING_VERSION, '1.2.0');
    assert.equal(buildSettings.CURRENT_PROJECT_VERSION, 9);
  }
  assert.deepEqual(configureIos({ root: dir }).changed, []);
});

test('a team chosen in Xcode and a key added to Info.plist by hand survive', () => {
  const dir = freshApp();
  configureIos({ root: dir });
  // What Xcode writes when a team is picked under Signing & Capabilities.
  const pbx = readFileSync(pbxprojOf(dir), 'utf8').replaceAll(
    'CODE_SIGN_STYLE = Automatic;',
    'CODE_SIGN_STYLE = Automatic;\n\t\t\t\tDEVELOPMENT_TEAM = AB12CDE345;',
  );
  writeFileSync(pbxprojOf(dir), pbx);
  const info = readInfo(dir);
  info.NSCameraUsageDescription = 'Added by hand';
  writeFileSync(infoPlistOf(dir), toPlistXml(info));

  assert.deepEqual(configureIos({ root: dir }).changed, []);
  assert.equal(readFileSync(pbxprojOf(dir), 'utf8'), pbx);
  assert.equal(readInfo(dir).NSCameraUsageDescription, 'Added by hand');
});

test('appleTeamId in app.config.json is written as the development team', () => {
  const dir = freshApp({ appleTeamId: 'ZY98XWV765' });
  configureIos({ root: dir });
  for (const buildSettings of targetSettings(dir)) {
    assert.equal(buildSettings.DEVELOPMENT_TEAM, 'ZY98XWV765');
    // Where Xcode itself would list it: alphabetically, not tacked on at the end.
    const keys = Object.keys(buildSettings);
    assert.deepEqual(keys, [...keys].sort());
    assert.equal(keys[keys.indexOf('DEVELOPMENT_TEAM') - 1], 'CURRENT_PROJECT_VERSION');
  }
  assert.deepEqual(configureIos({ root: dir }).changed, []);

  // Taking the id out of app.config.json again does not remove the team from the project.
  writeConfig(dir, {});
  assert.deepEqual(configureIos({ root: dir }).changed, []);
  for (const buildSettings of targetSettings(dir)) assert.equal(buildSettings.DEVELOPMENT_TEAM, 'ZY98XWV765');
});

test('an Info.plist saved in another layout is brought back to the standard one', () => {
  const dir = freshApp();
  configureIos({ root: dir });
  const standard = readFileSync(infoPlistOf(dir), 'utf8');
  writeFileSync(infoPlistOf(dir), plist.build(plist.parse(standard))); // same content, other indentation
  assert.notEqual(readFileSync(infoPlistOf(dir), 'utf8'), standard);
  assert.deepEqual(configureIos({ root: dir }).changed, ['ios/App/App/Info.plist']);
  assert.equal(readFileSync(infoPlistOf(dir), 'utf8'), standard);
});

// --- refusing to guess ------------------------------------------------------------------------

test('a project file the parser cannot reproduce exactly is not touched', () => {
  const dir = freshApp();
  // Same content, different layout: one setting indented with spaces instead of tabs.
  const odd = readFileSync(pbxprojOf(dir), 'utf8').replace('\t\t\t\tSWIFT_VERSION = 5.0;', '        SWIFT_VERSION = 5.0;');
  writeFileSync(pbxprojOf(dir), odd);
  const before = snapshot(dir);
  assert.throws(() => configureIos({ root: dir }), /cannot be reproduced exactly[\s\S]*--allow-reformat/);
  assert.deepEqual(snapshot(dir), before, 'nothing at all was written');

  const result = configureIos({ root: dir, allowReformat: true });
  assert.ok(result.notes.some((note) => note.includes('Review the diff')));
  assert.ok(!readFileSync(pbxprojOf(dir), 'utf8').includes('        SWIFT_VERSION'));
  assert.deepEqual(configureIos({ root: dir }).changed, [], 'after that, the strict run passes again');
});

test('a project that is not Capacitor\'s is refused with an explanation', () => {
  const dir = freshApp();
  writeFileSync(pbxprojOf(dir), readFileSync(pbxprojOf(dir), 'utf8').replaceAll('INFOPLIST_FILE = App/Info.plist;', 'INFOPLIST_FILE = Other/Info.plist;'));
  assert.throws(() => configureIos({ root: dir }), /Info\.plist is not App\/Info\.plist/);

  const empty = path.join(scratch, 'no-platform');
  mkdirSync(empty, { recursive: true });
  assert.throws(() => configureIos({ root: empty }), /npx cap add ios/);
});

test('mistakes in app.config.json are all listed, in plain words', () => {
  const dir = freshApp({
    appId: 'not a bundle id',
    version: 'one',
    build: 0,
    admob: { testing: true, ios: { ...realConfig.admob.ios, appId: 'ca-app-pub-3940256099942544/1458002511' } },
  });
  assert.throws(
    () => configureIos({ root: dir }),
    (error) => {
      for (const word of ['"appId"', '"version"', '"build"', '"admob.ios.appId"']) assert.ok(error.message.includes(word), word);
      assert.ok(!error.message.includes('"appName"'));
      return true;
    },
  );
});

test('a missing or empty SKAdNetwork list is an error, never a silent empty key', () => {
  const dir = freshApp();
  writeFileSync(path.join(dir, 'resources', 'skadnetwork-ids.json'), JSON.stringify({ identifiers: [] }));
  assert.throws(() => configureIos({ root: dir }), /update:skadnetwork/);
  rmSync(path.join(dir, 'resources', 'skadnetwork-ids.json'));
  assert.throws(() => configureIos({ root: dir }), /update:skadnetwork/);
});

// --- small parts ------------------------------------------------------------------------------

test('property lists are written the way Apple\'s tools write them and read back the same', () => {
  const value = {
    Zebra: 'last',
    Alpha: 'a < b & c > d',
    Flag: true,
    Off: false,
    Count: 3,
    Ratio: 1.5,
    Empty: [],
    Nothing: {},
    List: ['one', { Inner: 'x' }],
  };
  const xml = toPlistXml(value);
  assert.deepEqual(plist.parse(xml), value);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC'));
  assert.ok(xml.endsWith('</dict>\n</plist>\n'));
  assert.ok(xml.indexOf('<key>Alpha</key>') < xml.indexOf('<key>Zebra</key>'), 'keys are sorted');
  assert.ok(xml.includes('\t<string>a &lt; b &amp; c &gt; d</string>'));
  assert.ok(xml.includes('\t<key>Empty</key>\n\t<array/>'));
  assert.throws(() => toPlistXml({ When: new Date(0) }), /Cannot write/);
});

test('the SKAdNetwork list in resources/ is Google\'s, and the page reader finds identifiers', () => {
  assert.equal(skAdNetwork.source, 'https://developers.google.com/admob/ios/quick-start');
  assert.match(skAdNetwork.fetched, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(skAdNetwork.identifiers[0], GOOGLE_ID);
  assert.equal(new Set(skAdNetwork.identifiers).size, skAdNetwork.identifiers.length);
  assert.ok(skAdNetwork.identifiers.every((id) => /^[a-z0-9]{10}\.skadnetwork$/.test(id)));

  // The page shows the snippet HTML-escaped; identifiers elsewhere in the prose do not count.
  const page = `<p>for Google cstr6suwn9.skadnetwork and others</p><pre>&lt;key>SKAdNetworkItems&lt;/key>
    &lt;string>cstr6suwn9.skadnetwork&lt;/string> &lt;string&gt;4FZDC2EVR5.skadnetwork&lt;/string&gt;
    &lt;string>cstr6suwn9.skadnetwork&lt;/string></pre>`;
  assert.deepEqual(extractIdentifiers(page), ['cstr6suwn9.skadnetwork', '4fzdc2evr5.skadnetwork']);
  assert.deepEqual(extractIdentifiers('<html>moved</html>'), []);
});

test('the template archive these tests unpack is the one `cap add ios` uses', () => {
  assert.ok(existsSync(template), 'node_modules/@capacitor/cli/assets/ios-spm-template.tar.gz');
});
