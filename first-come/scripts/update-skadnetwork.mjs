// Refreshes resources/skadnetwork-ids.json from Google's AdMob iOS guide.
//
// SKAdNetwork identifiers tell iOS which ad networks may be credited when an advert in this
// game leads to an app install. Google publishes the list for AdMob (its own identifier plus
// the third-party buyers it works with) as an Info.plist snippet, and changes it from time to
// time. scripts/configure-ios.mjs copies the saved list into Info.plist; it never downloads.
//
//   npm run update:skadnetwork                    download Google's page and rewrite the list
//   npm run update:skadnetwork -- --from page.html   read a saved copy of the page instead
//
// Then run `npm run sync` and commit the result. Nothing is written when the page cannot be
// read or does not look as expected: identifiers are only ever taken from Google's page.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SOURCE_URL = 'https://developers.google.com/admob/ios/quick-start';
/** Google's own identifier. Its presence shows that the right snippet was found. */
export const GOOGLE_ID = 'cstr6suwn9.skadnetwork';
const MINIMUM_EXPECTED = 10;

/** The identifiers in the page's Info.plist snippet, in page order, without repeats. */
export function extractIdentifiers(html) {
  const text = html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  const found = [];
  for (const match of text.matchAll(/<string>\s*([a-z0-9]+\.skadnetwork)\s*<\/string>/gi)) {
    const id = match[1].toLowerCase();
    if (!found.includes(id)) found.push(id);
  }
  return found;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const target = path.join(root, 'resources', 'skadnetwork-ids.json');
  const fromIndex = process.argv.indexOf('--from');
  const fromFile = fromIndex >= 0 ? process.argv[fromIndex + 1] : null;

  let html;
  if (fromFile) {
    html = await readFile(fromFile, 'utf8');
  } else {
    const response = await fetch(SOURCE_URL, { redirect: 'follow' });
    if (!response.ok) throw new Error(`${SOURCE_URL} answered HTTP ${response.status}`);
    html = await response.text();
  }

  const identifiers = extractIdentifiers(html);
  if (!identifiers.includes(GOOGLE_ID) || identifiers.length < MINIMUM_EXPECTED) {
    throw new Error(
      `Found ${identifiers.length} identifiers and ${identifiers.includes(GOOGLE_ID) ? '' : 'not '}Google's own ` +
        `(${GOOGLE_ID}). The page layout has probably changed; nothing was written. ` +
        `Open ${SOURCE_URL} and compare it with ${path.relative(root, target)} by hand.`,
    );
  }

  const previous = JSON.parse(await readFile(target, 'utf8').catch(() => '{"identifiers":[]}'));
  const added = identifiers.filter((id) => !previous.identifiers.includes(id));
  const removed = previous.identifiers.filter((id) => !identifiers.includes(id));
  if (added.length === 0 && removed.length === 0 && previous.identifiers.join() === identifiers.join()) {
    console.log(`update:skadnetwork: no change (${identifiers.length} identifiers, read ${previous.fetched}).`);
    return;
  }

  const data = {
    source: SOURCE_URL,
    fetched: new Date().toISOString().slice(0, 10),
    identifiers,
  };
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`);
  console.log(
    `update:skadnetwork: wrote ${identifiers.length} identifiers to ${path.relative(root, target)} ` +
      `(${added.length} added, ${removed.length} removed). Now run: npm run sync`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`update:skadnetwork: ${error.message}`);
    process.exit(1);
  });
}
