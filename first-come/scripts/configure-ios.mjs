// Applies app.config.json to the Xcode project in ios/.
//
// `npx cap add ios` creates a generic project and `cap sync` only refreshes the web files and
// the plugin list. Everything that makes the project THIS app is written here, so that the
// app's name, bundle id, version, AdMob ids, icon and so on are changed in one place
// (app.config.json and resources/) and never by hand in Xcode:
//
//   ios/App/App/Info.plist                    display name, AdMob app id, tracking prompt text,
//                                             SKAdNetwork list, portrait only, export compliance
//   ios/App/App.xcodeproj/project.pbxproj     bundle id, version, build, iPhone only, automatic
//                                             signing; adds the two files below to the project
//   ios/App/App/PrivacyInfo.xcprivacy         the app's privacy manifest (required-reason APIs)
//   ios/App/Products.storekit                 local test product for the Remove Ads purchase
//   ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme
//                                             shared "App" scheme that uses Products.storekit
//   ios/App/App/Assets.xcassets/...           icon and launch image from resources/, if present
//
// Run it through `npm run sync` (which runs it after `cap sync ios`), or alone:
//
//   node scripts/configure-ios.mjs            write whatever is out of date
//   node scripts/configure-ios.mjs --check    write nothing; exit 1 if something is out of date
//
// It is idempotent: a second run changes nothing. It keeps what it does not own, for example
// the development team chosen in Xcode.

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import plist from 'plist';
import xcode from 'xcode';
import { ConfigureError, applyPlan, firstDifference, readPngInfo, xmlText } from './configure-shared.mjs';

// The layout `cap add ios` creates. Relative to the folder that holds app.config.json.
const IOS_PROJECT_DIR = 'ios/App';
const XCODEPROJ = 'App.xcodeproj';
const TARGET_DIR = 'App'; // inside IOS_PROJECT_DIR: the app target's sources and resources
const SCHEME_NAME = 'App';
const PRIVACY_MANIFEST = 'PrivacyInfo.xcprivacy';
const STOREKIT_FILE = 'Products.storekit';

/**
 * The app's own privacy manifest.
 *
 * It declares the "required reason" APIs used by the app's code and by the Capacitor plugins
 * that are compiled into it and ship no manifest of their own. Searched for in
 * node_modules/<plugin>/ios on 2026-11-13: of the eight plugins, only @capacitor/preferences
 * uses one (UserDefaults, for the game's saved progress), reason CA92.1: "access user defaults
 * to read and write information that is only accessible to the app itself". This matches the
 * sample in Capacitor's documentation (capacitorjs.com/docs/ios/privacy-manifest).
 *
 * The Google Mobile Ads and User Messaging Platform SDKs are separate binaries with their own
 * manifests; their data collection and tracking are declared there, not here.
 *
 * Adding a plugin? Search its ios/ folder for UserDefaults, file timestamps, system boot time,
 * disk space and active keyboard APIs, and add a category here if it has no PrivacyInfo.xcprivacy.
 */
const PRIVACY_MANIFEST_CONTENT = {
  NSPrivacyAccessedAPITypes: [
    {
      NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
      NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
    },
  ],
  NSPrivacyCollectedDataTypes: [],
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: [],
};

// ---------------------------------------------------------------------------------------------
// app.config.json

function readAppConfig(root) {
  const file = path.join(root, 'app.config.json');
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigureError(`Cannot read app.config.json: ${error.message}`);
  }
  const problems = [];
  const need = (ok, message) => {
    if (!ok) problems.push(message);
  };
  const isText = (value) => typeof value === 'string' && value.trim().length > 0;

  need(
    isText(config.appId) && /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/.test(config.appId),
    '"appId" must be a bundle id such as com.yourname.firstcome (letters, digits, hyphens and dots)',
  );
  need(isText(config.appName), '"appName" must be the name shown under the icon');
  need(
    isText(config.version) && /^\d+(\.\d+){0,2}$/.test(config.version),
    '"version" must be one to three numbers separated by dots, such as 1.0.0',
  );
  need(Number.isInteger(config.build) && config.build >= 1, '"build" must be a whole number, 1 or more');
  need(
    isText(config.admob?.ios?.appId) && /^ca-app-pub-\d{16}~\d{10}$/.test(config.admob.ios.appId),
    '"admob.ios.appId" must be an AdMob app id: ca-app-pub-XXXXXXXXXXXXXXXX~YYYYYYYYYY (with a ~, not a /)',
  );
  need(isText(config.trackingUsageDescription), '"trackingUsageDescription" must be the sentence iOS shows in the tracking prompt');
  need(isText(config.iap?.removeAdsProductId), '"iap.removeAdsProductId" must be the product id of the Remove Ads purchase');
  need(
    config.appleTeamId === undefined || config.appleTeamId === '' || /^[A-Z0-9]{10}$/.test(config.appleTeamId),
    '"appleTeamId", when present, must be the 10-character Apple team id',
  );
  if (problems.length > 0) {
    throw new ConfigureError(`app.config.json needs fixing:\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}

function readSkAdNetworkIds(root) {
  const file = path.join(root, 'resources', 'skadnetwork-ids.json');
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigureError(`Cannot read resources/skadnetwork-ids.json (${error.message}). Run: npm run update:skadnetwork`);
  }
  const ids = data.identifiers;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => /^[a-z0-9]+\.skadnetwork$/.test(id))) {
    throw new ConfigureError('resources/skadnetwork-ids.json has no valid "identifiers" list. Run: npm run update:skadnetwork');
  }
  return { ids: [...new Set(ids)], fetched: data.fetched };
}

// ---------------------------------------------------------------------------------------------
// Property lists, written the way Apple's own tools write them (tabs, sorted keys), so that a
// later save from Xcode does not reshuffle the file.

export function toPlistXml(rootValue) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
  ];
  const emit = (value, depth) => {
    const pad = '\t'.repeat(depth);
    if (typeof value === 'string') {
      lines.push(`${pad}<string>${xmlText(value)}</string>`);
    } else if (typeof value === 'boolean') {
      lines.push(`${pad}<${value}/>`);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      lines.push(Number.isInteger(value) ? `${pad}<integer>${value}</integer>` : `${pad}<real>${value}</real>`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}<array/>`);
      } else {
        lines.push(`${pad}<array>`);
        for (const item of value) emit(item, depth + 1);
        lines.push(`${pad}</array>`);
      }
    } else if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      const keys = Object.keys(value).sort();
      if (keys.length === 0) {
        lines.push(`${pad}<dict/>`);
      } else {
        lines.push(`${pad}<dict>`);
        for (const key of keys) {
          lines.push(`${pad}\t<key>${xmlText(key)}</key>`);
          emit(value[key], depth + 1);
        }
        lines.push(`${pad}</dict>`);
      }
    } else {
      // Dates and binary data do not occur in the files this script writes.
      throw new ConfigureError(`Cannot write a property-list value of this kind: ${Object.prototype.toString.call(value)}`);
    }
  };
  emit(rootValue, 0);
  lines.push('</plist>', '');
  return lines.join('\n');
}

function buildInfoPlist(existingXml, config, skAdNetworkIds) {
  let info;
  try {
    info = plist.parse(existingXml);
  } catch (error) {
    throw new ConfigureError(`${IOS_PROJECT_DIR}/${TARGET_DIR}/Info.plist does not parse: ${error.message}`);
  }
  if (info === null || typeof info !== 'object' || Array.isArray(info)) {
    throw new ConfigureError(`${IOS_PROJECT_DIR}/${TARGET_DIR}/Info.plist is not a dictionary.`);
  }

  // Name under the icon.
  info.CFBundleDisplayName = config.appName;
  // Version and build come from the Xcode build settings, which this script sets from
  // app.config.json (and which CI can override per build).
  info.CFBundleShortVersionString = '$(MARKETING_VERSION)';
  info.CFBundleVersion = '$(CURRENT_PROJECT_VERSION)';

  // AdMob. The Google Mobile Ads SDK stops the app at launch when this is missing or wrong.
  info.GADApplicationIdentifier = config.admob.ios.appId;
  // Shown in the "Allow ... to track your activity" prompt. iOS ends the app if the prompt is
  // requested without it.
  info.NSUserTrackingUsageDescription = config.trackingUsageDescription;
  // Ad networks that may be credited for installs: Google's published list.
  info.SKAdNetworkItems = skAdNetworkIds.map((id) => ({ SKAdNetworkIdentifier: id }));

  // The app only uses the encryption built into iOS (HTTPS), which is exempt from export
  // documentation. Declaring it here stops App Store Connect asking for every build.
  info.ITSAppUsesNonExemptEncryption = false;

  // Portrait only, iPhone only.
  info.UISupportedInterfaceOrientations = ['UIInterfaceOrientationPortrait'];
  delete info['UISupportedInterfaceOrientations~ipad'];
  // The template still says armv7 (32-bit). Every device that can run iOS 15 is arm64.
  info.UIRequiredDeviceCapabilities = ['arm64'];
  // The game is dark in every colour scheme. Without this the status bar (clock, battery) is
  // drawn in black on the game's dark background whenever the phone is in light mode.
  info.UIUserInterfaceStyle = 'Dark';

  return toPlistXml(info);
}

// ---------------------------------------------------------------------------------------------
// Icon and launch image

function planAssets(root, plan, notes) {
  const assets = path.join(root, IOS_PROJECT_DIR, TARGET_DIR, 'Assets.xcassets');
  const readSet = (name) => {
    const dir = path.join(assets, name);
    let contents;
    try {
      contents = JSON.parse(readFileSync(path.join(dir, 'Contents.json'), 'utf8'));
    } catch (error) {
      throw new ConfigureError(`Cannot read Assets.xcassets/${name}/Contents.json: ${error.message}`);
    }
    const files = [...new Set((contents.images ?? []).map((image) => image.filename).filter(Boolean))];
    return { dir, images: contents.images ?? [], files };
  };

  // App icon: the template's catalogue has one 1024 x 1024 image from which Xcode makes every
  // size. The file name it expects is read from Contents.json, which is left as it is.
  const iconSource = path.join(root, 'resources', 'icon-1024.png');
  if (existsSync(iconSource)) {
    const png = readFileSync(iconSource);
    const info = readPngInfo(png, 'resources/icon-1024.png');
    if (info.width !== 1024 || info.height !== 1024) {
      throw new ConfigureError(`resources/icon-1024.png is ${info.width} x ${info.height}; it must be 1024 x 1024.`);
    }
    if (info.transparency) {
      throw new ConfigureError(
        'resources/icon-1024.png has an alpha channel or transparent colours. The App Store rejects such an icon: ' +
          'export it again as an opaque PNG (no transparency).',
      );
    }
    const icon = readSet('AppIcon.appiconset');
    if (icon.files.length !== 1 || icon.images.length !== 1 || icon.images[0].size !== '1024x1024') {
      throw new ConfigureError('AppIcon.appiconset no longer has the single 1024x1024 slot this script fills. Update scripts/configure-ios.mjs.');
    }
    plan.set(path.join(icon.dir, icon.files[0]), png);
  } else {
    notes.push('resources/icon-1024.png not found: the icon already in the project is kept.');
  }

  // Launch image: the template shows the "Splash" image, scaled to fill the screen, in its
  // launch storyboard. Its three slots (1x, 2x, 3x) all hold the same 2732 x 2732 picture.
  const splashSource = path.join(root, 'resources', 'splash-2732.png');
  if (existsSync(splashSource)) {
    const png = readFileSync(splashSource);
    const info = readPngInfo(png, 'resources/splash-2732.png');
    if (info.width !== 2732 || info.height !== 2732) {
      throw new ConfigureError(`resources/splash-2732.png is ${info.width} x ${info.height}; it must be 2732 x 2732.`);
    }
    const splash = readSet('Splash.imageset');
    if (splash.files.length === 0) {
      throw new ConfigureError('Splash.imageset lists no image files. Update scripts/configure-ios.mjs.');
    }
    for (const file of splash.files) plan.set(path.join(splash.dir, file), png);
  } else {
    notes.push('resources/splash-2732.png not found: the launch image already in the project is kept.');
  }
}

// ---------------------------------------------------------------------------------------------
// StoreKit configuration file: a local stand-in for App Store Connect, used when the app is
// run from Xcode. Written in the layout Xcode's own editor uses.

function shortId(seed) {
  return createHash('sha1').update(seed).digest('hex').slice(0, 8).toUpperCase();
}

function appleJson(value, depth = 0) {
  const pad = '  '.repeat(depth);
  const inner = '  '.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return `[\n\n${pad}]`;
    return `[\n${value.map((item) => inner + appleJson(item, depth + 1)).join(',\n')}\n${pad}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'en'));
    if (keys.length === 0) return `{\n\n${pad}}`;
    return `{\n${keys.map((key) => `${inner}${JSON.stringify(key)} : ${appleJson(value[key], depth + 1)}`).join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

function buildStoreKitFile(config) {
  const productId = config.iap.removeAdsProductId;
  return `${appleJson({
    identifier: shortId(`storekit-file:${STOREKIT_FILE}`),
    nonRenewingSubscriptions: [],
    products: [
      {
        // Only what a local test purchase shows. The real price and texts are set in
        // App Store Connect.
        displayPrice: '2.99',
        familyShareable: false,
        internalID: shortId(`storekit-product:${productId}`),
        localizations: [
          {
            description: 'Removes the adverts from the game for good.',
            displayName: 'Remove Ads',
            locale: 'en_US',
          },
        ],
        productID: productId,
        referenceName: 'Remove Ads',
        type: 'NonConsumable',
      },
    ],
    settings: {},
    subscriptionGroups: [],
    version: { major: 1, minor: 1 },
  })}\n`;
}

// ---------------------------------------------------------------------------------------------
// project.pbxproj, through the "xcode" package (the parser the Capacitor CLI itself uses)

function unquote(value) {
  const text = String(value);
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return text;
}

/** A string the way Xcode writes it: bare when it is made of safe characters, quoted otherwise. */
function pbxString(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** A stable 24-character object id, so that every run and every machine adds the same lines. */
function stableId(label) {
  return createHash('sha1').update(`configure-ios:${label}`).digest('hex').slice(0, 24).toUpperCase();
}

function parsePbx(text, scratchDir) {
  const file = path.join(scratchDir, `project-${createHash('sha1').update(text).digest('hex').slice(0, 12)}.pbxproj`);
  writeFileSync(file, text);
  let project;
  try {
    project = xcode.project(file).parseSync();
  } catch (error) {
    throw new ConfigureError(`project.pbxproj does not parse: ${error.message}`);
  }
  // The parser reads every unquoted run of digits as a number, so `LastUpgradeCheck = 0920;`
  // would come back out as 920. Put such values back as they were written.
  const literals = new Map();
  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*) = (0[0-9]+);/g)) {
    if (!literals.has(match[1])) literals.set(match[1], new Set());
    literals.get(match[1]).add(match[2]);
  }
  const restore = (node) => {
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'number' && literals.has(key)) {
        for (const literal of literals.get(key)) if (Number(literal) === value) node[key] = literal;
      } else {
        restore(value);
      }
    }
  };
  restore(project.hash);
  return project;
}

/** The parts of the parsed project this script works on. Throws if the layout is not Capacitor's. */
function locate(project) {
  const objects = project.hash.project.objects;
  const section = (name) => objects[name] ?? {};
  const entries = (name) => Object.entries(section(name)).filter(([key]) => !key.endsWith('_comment'));
  const fail = (what) => {
    throw new ConfigureError(`project.pbxproj: ${what}. This script expects the project that \`npx cap add ios\` creates.`);
  };

  const pbxProject = section('PBXProject')[project.hash.project.rootObject] ?? fail('no root project object');
  const targets = (pbxProject.targets ?? []).map((ref) => [ref.value, section('PBXNativeTarget')[ref.value]]);
  const [targetId, target] =
    targets.find(([, t]) => t && unquote(t.productType) === 'com.apple.product-type.application') ?? fail('no application target');

  const configList = section('XCConfigurationList')[target.buildConfigurationList] ?? fail('the app target has no build configuration list');
  const configs = configList.buildConfigurations.map(
    (ref) => section('XCBuildConfiguration')[ref.value] ?? fail('a build configuration is missing'),
  );
  if (configs.length === 0) fail('the app target has no build configurations');
  for (const config of configs) {
    if (unquote(config.buildSettings?.INFOPLIST_FILE ?? '') !== `${TARGET_DIR}/Info.plist`) {
      fail(`the app target's Info.plist is not ${TARGET_DIR}/Info.plist`);
    }
  }

  const mainGroup = section('PBXGroup')[pbxProject.mainGroup] ?? fail('no main group');
  const appGroupRef =
    (mainGroup.children ?? []).find((ref) => {
      const group = section('PBXGroup')[ref.value];
      return group && unquote(group.path ?? '') === TARGET_DIR;
    }) ?? fail(`no "${TARGET_DIR}" group`);
  const appGroup = section('PBXGroup')[appGroupRef.value];

  const resourcesRef =
    (target.buildPhases ?? []).find((ref) => section('PBXResourcesBuildPhase')[ref.value]) ?? fail('the app target has no Resources build phase');
  const resourcesPhase = section('PBXResourcesBuildPhase')[resourcesRef.value];

  const productRef = section('PBXFileReference')[target.productReference] ?? fail('the app target has no product');

  return { objects, section, entries, pbxProject, targetId, target, configs, mainGroup, appGroup, resourcesPhase, productRef };
}

function assertUnusedId(objects, id, label) {
  for (const sectionObjects of Object.values(objects)) {
    if (Object.hasOwn(sectionObjects, id)) {
      throw new ConfigureError(`project.pbxproj already uses the object id ${id} that this script reserves for ${label}.`);
    }
  }
}

/**
 * Adds an object to a section. Xcode keeps each section sorted by object id; when the section
 * is in that order, the new object goes where Xcode would put it, so that a later save from
 * Xcode does not move it. Otherwise it goes at the end.
 */
function addObject(objects, sectionName, id, object, comment) {
  const section = objects[sectionName];
  const ids = Object.keys(section).filter((key) => !key.endsWith('_comment'));
  const wasSorted = ids.every((key, index) => index === 0 || ids[index - 1] < key);
  section[id] = object;
  section[`${id}_comment`] = comment;
  if (!wasSorted) return;
  const sorted = {};
  for (const key of [...ids, id].sort()) {
    sorted[key] = section[key];
    if (Object.hasOwn(section, `${key}_comment`)) sorted[`${key}_comment`] = section[`${key}_comment`];
  }
  objects[sectionName] = sorted;
}

/** Makes sure `fileName` is listed in `group`; returns the id of its file reference. */
function ensureFileReference(parts, group, fileName, lastKnownFileType) {
  const { objects, entries } = parts;
  const inGroup = new Set((group.children ?? []).map((ref) => ref.value));
  const existing = entries('PBXFileReference').find(([id, ref]) => inGroup.has(id) && unquote(ref.path ?? '') === fileName);
  if (existing) return existing[0];

  const id = stableId(`file:${fileName}`);
  assertUnusedId(objects, id, fileName);
  addObject(
    objects,
    'PBXFileReference',
    id,
    { isa: 'PBXFileReference', lastKnownFileType, path: pbxString(fileName), sourceTree: '"<group>"' },
    fileName,
  );
  group.children.push({ value: id, comment: fileName });
  return id;
}

/** Makes sure the file is copied into the app as a resource. */
function ensureResource(parts, fileId, fileName) {
  const { objects, entries, resourcesPhase } = parts;
  const inPhase = new Set((resourcesPhase.files ?? []).map((ref) => ref.value));
  if (entries('PBXBuildFile').some(([id, buildFile]) => inPhase.has(id) && buildFile.fileRef === fileId)) return;

  const id = stableId(`resource:${fileName}`);
  assertUnusedId(objects, id, `${fileName} in Resources`);
  addObject(objects, 'PBXBuildFile', id, { isa: 'PBXBuildFile', fileRef: fileId, fileRef_comment: fileName }, `${fileName} in Resources`);
  resourcesPhase.files.push({ value: id, comment: `${fileName} in Resources` });
}

function expectedBuildSettings(config) {
  const settings = {
    PRODUCT_BUNDLE_IDENTIFIER: pbxString(config.appId),
    MARKETING_VERSION: pbxString(config.version),
    CURRENT_PROJECT_VERSION: config.build,
    // 1 = iPhone. (iPad owners can still install an iPhone app; it runs in iPhone size.)
    TARGETED_DEVICE_FAMILY: 1,
    // Xcode creates and renews certificates and profiles itself.
    CODE_SIGN_STYLE: 'Automatic',
  };
  // Optional. Without it, the team chosen in Xcode (or passed on the xcodebuild command line,
  // as the TestFlight workflow does) is left alone.
  if (config.appleTeamId) settings.DEVELOPMENT_TEAM = pbxString(config.appleTeamId);
  return settings;
}

/**
 * Sets build settings. An existing setting keeps its place. A new one goes where Xcode would
 * put it (Xcode lists settings alphabetically) when the list is in that order, else at the end.
 */
function applyBuildSettings(buildConfig, settings) {
  for (const [key, value] of Object.entries(settings)) {
    const current = buildConfig.buildSettings;
    const keys = Object.keys(current);
    const wasSorted = keys.every((name, index) => index === 0 || keys[index - 1] < name);
    current[key] = value;
    if (keys.includes(key) || !wasSorted) continue;
    buildConfig.buildSettings = Object.fromEntries([...keys, key].sort().map((name) => [name, current[name]]));
  }
}

function buildProjectFile(existingText, config, scratchDir, { allowReformat }) {
  const project = parsePbx(existingText, scratchDir);

  // Guard: the parser must be able to reproduce the file exactly before it is trusted to
  // change it. A difference here would mean it lost or altered something it did not understand.
  const unchanged = project.writeSync();
  if (unchanged !== existingText && !allowReformat) {
    throw new ConfigureError(
      'project.pbxproj cannot be reproduced exactly by the parser, so it was not touched ' +
        `(${firstDifference(existingText, unchanged)}).\n` +
        'If the difference is only layout, run `node scripts/configure-ios.mjs --allow-reformat` once and ' +
        'review the change with `git diff` before committing.',
    );
  }

  const parts = locate(project);
  const settings = expectedBuildSettings(config);
  for (const buildConfig of parts.configs) applyBuildSettings(buildConfig, settings);

  const privacyId = ensureFileReference(parts, parts.appGroup, PRIVACY_MANIFEST, 'text.xml');
  ensureResource(parts, privacyId, PRIVACY_MANIFEST);
  // Listed in the project so it can be opened in Xcode; deliberately not a resource of the app.
  ensureFileReference(parts, parts.mainGroup, STOREKIT_FILE, 'text');

  const output = project.writeSync();

  // Prove the result: it must parse again, come out byte for byte the same when written
  // again, and hold what was asked for.
  const reparsed = parsePbx(output, scratchDir);
  if (reparsed.writeSync() !== output) {
    throw new ConfigureError(`The edited project.pbxproj is not stable when parsed and written again (${firstDifference(output, reparsed.writeSync())}).`);
  }
  const check = locate(reparsed);
  for (const buildConfig of check.configs) {
    for (const [key, value] of Object.entries(settings)) {
      if (unquote(buildConfig.buildSettings[key]) !== unquote(value)) {
        throw new ConfigureError(`The edited project.pbxproj lost the build setting ${key}.`);
      }
    }
  }
  const resourceFiles = new Set(
    (check.resourcesPhase.files ?? []).map((ref) => {
      const buildFile = check.section('PBXBuildFile')[ref.value];
      const fileRef = buildFile && check.section('PBXFileReference')[buildFile.fileRef];
      return fileRef ? unquote(fileRef.path ?? '') : '';
    }),
  );
  if (!resourceFiles.has(PRIVACY_MANIFEST)) {
    throw new ConfigureError(`The edited project.pbxproj does not copy ${PRIVACY_MANIFEST} into the app.`);
  }

  return {
    text: output,
    reformatted: unchanged !== existingText,
    target: {
      id: check.targetId,
      name: unquote(check.target.name),
      product: unquote(check.productRef.path),
      lastUpgradeCheck: String(check.pbxProject.attributes?.LastUpgradeCheck ?? '0920'),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Shared scheme. Without a scheme file xcodebuild makes one up on each machine; with one, the
// "App" scheme is the same everywhere, and running from Xcode uses Products.storekit, so the
// Remove Ads purchase can be tried in the simulator before App Store Connect is set up.
// Archives (TestFlight, App Store) are not affected by the StoreKit file.

function buildScheme(target) {
  const attribute = (value) => xmlText(value).replace(/"/g, '&quot;');
  const buildable = (indent) =>
    [
      '<BuildableReference',
      '   BuildableIdentifier = "primary"',
      `   BlueprintIdentifier = "${attribute(target.id)}"`,
      `   BuildableName = "${attribute(target.product)}"`,
      `   BlueprintName = "${attribute(target.name)}"`,
      `   ReferencedContainer = "container:${attribute(XCODEPROJ)}">`,
      '</BuildableReference>',
    ]
      .map((line) => indent + line)
      .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "${attribute(target.lastUpgradeCheck)}"
   version = "1.3">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
${buildable('            ')}
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
      </Testables>
   </TestAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
${buildable('         ')}
      </BuildableProductRunnable>
      <StoreKitConfigurationFileReference
         identifier = "../../${attribute(STOREKIT_FILE)}">
      </StoreKitConfigurationFileReference>
   </LaunchAction>
   <ProfileAction
      buildConfiguration = "Release"
      shouldUseLaunchSchemeArgsEnv = "YES"
      savedToolIdentifier = ""
      useCustomWorkingDirectory = "NO"
      debugDocumentVersioning = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
${buildable('         ')}
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction
      buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
`;
}

// ---------------------------------------------------------------------------------------------

/**
 * Brings ios/ in line with app.config.json and resources/.
 *
 * @param {object} options
 * @param {string} options.root            Folder that holds app.config.json, resources/ and ios/.
 * @param {boolean} [options.check]        Write nothing; only report what is out of date.
 * @param {boolean} [options.allowReformat] Accept a project.pbxproj the parser lays out differently.
 * @returns {{changed: string[], unchanged: string[], notes: string[], summary: string}}
 *          Paths are relative to `root`, with forward slashes.
 */
export function configureIos({ root, check = false, allowReformat = false }) {
  const projectDir = path.join(root, IOS_PROJECT_DIR);
  const pbxprojPath = path.join(projectDir, XCODEPROJ, 'project.pbxproj');
  const infoPlistPath = path.join(projectDir, TARGET_DIR, 'Info.plist');
  if (!existsSync(pbxprojPath) || !existsSync(infoPlistPath)) {
    throw new ConfigureError(`No Xcode project in ${IOS_PROJECT_DIR}. Create it first with: npx cap add ios`);
  }

  const config = readAppConfig(root);
  const skAdNetwork = readSkAdNetworkIds(root);
  const notes = [];
  /** @type {Map<string, string | Buffer>} absolute path -> wanted content */
  const plan = new Map();

  const infoPlist = buildInfoPlist(readFileSync(infoPlistPath, 'utf8'), config, skAdNetwork.ids);
  // Self-check: what was written must read back as a property list with the same content.
  if (toPlistXml(plist.parse(infoPlist)) !== infoPlist) {
    throw new ConfigureError('Internal error: the Info.plist this script produced does not read back unchanged.');
  }
  plan.set(infoPlistPath, infoPlist);
  plan.set(path.join(projectDir, TARGET_DIR, PRIVACY_MANIFEST), toPlistXml(PRIVACY_MANIFEST_CONTENT));
  plan.set(path.join(projectDir, STOREKIT_FILE), buildStoreKitFile(config));
  planAssets(root, plan, notes);

  const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'configure-ios-'));
  let project;
  try {
    project = buildProjectFile(readFileSync(pbxprojPath, 'utf8'), config, scratchDir, { allowReformat });
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
  if (project.reformatted) notes.push('project.pbxproj was laid out differently from how the parser writes it; it has been rewritten. Review the diff.');
  plan.set(pbxprojPath, project.text);
  plan.set(path.join(projectDir, XCODEPROJ, 'xcshareddata', 'xcschemes', `${SCHEME_NAME}.xcscheme`), buildScheme(project.target));

  const { changed, unchanged } = applyPlan(root, plan, { check });

  const summary =
    `${config.appName} (${config.appId}) ${config.version} build ${config.build}, iPhone only, portrait; ` +
    `${skAdNetwork.ids.length} SKAdNetwork identifiers (Google's list as read on ${skAdNetwork.fetched})`;
  return { changed, unchanged, notes, summary };
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !['--check', '--allow-reformat'].includes(arg));
  if (unknown.length > 0) {
    console.error(`configure:ios: unknown option ${unknown.join(' ')}. Options: --check, --allow-reformat`);
    process.exit(2);
  }
  const check = args.includes('--check');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  let result;
  try {
    result = configureIos({ root, check, allowReformat: args.includes('--allow-reformat') });
  } catch (error) {
    if (!(error instanceof ConfigureError)) throw error;
    console.error(`configure:ios: ${error.message}`);
    process.exit(1);
  }

  for (const note of result.notes) console.log(`configure:ios: note: ${note}`);
  if (check) {
    if (result.changed.length === 0) {
      console.log(`configure:ios: the Xcode project is up to date with app.config.json (${result.unchanged.length} files checked).`);
      return;
    }
    console.error('configure:ios: out of date (run `npm run sync` and commit the result):');
    for (const file of result.changed) console.error(`  ${file}`);
    process.exit(1);
  }
  for (const file of result.changed) console.log(`configure:ios: wrote ${file}`);
  console.log(
    `configure:ios: ${result.changed.length} written, ${result.unchanged.length} already up to date. ${result.summary}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
