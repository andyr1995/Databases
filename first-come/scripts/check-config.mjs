// Checks, before `npm run sync` writes anything, that app.config.json and the two native
// projects are fit for BOTH platforms.
//
// `npm run sync` works through iPhone and Android one after the other. The two stores do not
// accept the same values (a bundle id with a hyphen is fine for Apple and impossible on
// Android; Google Play has a largest version code; each platform has AdMob ids of its own), so
// without this step a value that only one of them refuses would stop the sync half way: the
// web game copied, the Xcode project already rewritten, the Android project not.
//
// It runs both configure scripts in their --check mode, in which they work everything out and
// write nothing, and reports every refusal from either. That a project is merely out of date
// is not a refusal: bringing it up to date is what the sync is for.
//
//   node scripts/check-config.mjs     exit 1, with the reasons, if either platform refuses

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { configureAndroid } from './configure-android.mjs';
import { configureIos } from './configure-ios.mjs';
import { ConfigureError } from './configure-shared.mjs';

const PLATFORMS = [
  { name: 'iPhone', configure: configureIos },
  { name: 'Android', configure: configureAndroid },
];

/**
 * @param {object} options
 * @param {string} options.root  Folder that holds app.config.json, ios/ and android/.
 * @returns {{platform: string, message: string}[]}  What each platform refuses; empty when both accept.
 */
export function checkConfig({ root }) {
  const refusals = [];
  for (const { name, configure } of PLATFORMS) {
    try {
      configure({ root, check: true });
    } catch (error) {
      if (!(error instanceof ConfigureError)) throw error;
      refusals.push({ platform: name, message: error.message });
    }
  }
  return refusals;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    console.error(`check:config: unknown option ${args.join(' ')}. This script takes none.`);
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const refusals = checkConfig({ root });
  if (refusals.length === 0) {
    console.log('check:config: app.config.json and both native projects are fit for iPhone and for Android.');
    return;
  }
  for (const { platform, message } of refusals) console.error(`check:config: ${platform}: ${message}`);
  console.error('check:config: nothing was written. Fix the above and run `npm run sync` again.');
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
