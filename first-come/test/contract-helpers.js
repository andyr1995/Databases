// Shared by contract.test.js (bridge source + fake plugins) and bundle.test.js (the built
// file): load the game's real js/platform.js and compare an installed platform against it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const appConfig = JSON.parse(readFileSync(path.join(root, 'app.config.json'), 'utf8'));
/** The web app, located through app.config.json like everything else. */
export const webDir = path.resolve(root, appConfig.webDir);

let copies = 0;

/** A fresh, untouched copy of the web module (a new module instance on every call). */
export async function loadWebPlatform() {
  const url = pathToFileURL(path.join(webDir, 'js', 'platform.js'));
  url.searchParams.set('copy', String(++copies));
  const mod = await import(url.href);
  assert.equal(typeof mod.platform, 'object', 'platform.js exports `platform`');
  assert.equal(typeof mod.noAds, 'object', 'platform.js exports `noAds`');
  assert.equal(typeof mod.noIap, 'object', 'platform.js exports `noIap`');
  return mod;
}

const kind = (value) => (value === null ? 'null' : typeof value);

/** { member: typeof } for every own member. */
export const shapeOf = (object) => Object.fromEntries(Object.keys(object).map((key) => [key, typeof object[key]]));

/**
 * Every member `reference` has must exist on `actual` with the same type.
 * Extra members on `actual` are allowed; missing or retyped ones are not.
 */
export function assertSameMembers(actual, reference, label) {
  assert.equal(kind(actual), 'object', `${label} is an object`);
  for (const [key, type] of Object.entries(shapeOf(reference))) {
    assert.ok(key in actual, `${label}.${key} is missing after install()`);
    assert.equal(typeof actual[key], type, `${label}.${key} changed type`);
  }
}

/** The whole contract: platform, platform.persist, platform.ads vs noAds, platform.iap vs noIap. */
export function assertContract(installed, web) {
  assertSameMembers(installed, web.platform, 'platform');
  assertSameMembers(installed.persist, web.platform.persist, 'platform.persist');
  assertSameMembers(installed.ads, web.noAds, 'platform.ads');
  assertSameMembers(installed.iap, web.noIap, 'platform.iap');
  assert.notEqual(installed.ads, web.noAds, 'the web "no ads" provider was replaced');
  assert.notEqual(installed.iap, web.noIap, 'the web "no purchases" provider was replaced');
}

/**
 * Call every function member with harmless arguments and record what kind of value comes
 * back: 'boolean', 'Promise<undefined>', ... Rejections and throws fail the test.
 */
export async function resultKinds(object, args = {}) {
  const out = {};
  for (const key of Object.keys(object)) {
    const member = object[key];
    if (typeof member !== 'function') continue;
    let result;
    try {
      result = member.apply(object, args[key] ?? []);
    } catch (error) {
      assert.fail(`${key}() threw: ${error && error.message}`);
    }
    if (result && typeof result.then === 'function') {
      try {
        out[key] = `Promise<${kind(await result)}>`;
      } catch (error) {
        assert.fail(`${key}() rejected: ${error && error.message}`);
      }
    } else {
      out[key] = kind(result);
    }
  }
  return out;
}

export const ADS_ARGS = { onBannerHeight: [() => {}] };
