// scripts/select-xcode.sh picks the Xcode the CI workflows build with. It is run here against
// a pretend /Applications folder, with a stand-in for macOS's PlistBuddy, so the choice
// (newest, stable, real folders only) is checked without a Mac.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { toPlistXml } from '../scripts/configure-ios.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'select-xcode.sh');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'select-xcode-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Stand-in for /usr/libexec/PlistBuddy: only `-c "Print :Key" file`, for string values.
const plistBuddy = path.join(scratch, 'PlistBuddy');
writeFileSync(
  plistBuddy,
  `#!/usr/bin/env node
const fs = require('node:fs');
const key = process.argv[3].split(':')[1];
let xml = '';
try { xml = fs.readFileSync(process.argv[4], 'utf8'); } catch {}
const match = xml.match(new RegExp('<key>' + key + '</key>\\\\s*<string>([^<]*)</string>'));
if (!match) { console.error('Print: Entry, ":' + key + '", Does Not Exist'); process.exit(1); }
console.log(match[1]);
`,
);
chmodSync(plistBuddy, 0o755);

let counter = 0;
/** installs: [folder name, version, licence type or null]; links: [link name, target name] */
function applications(installs, links = []) {
  counter += 1;
  const dir = path.join(scratch, `Applications-${counter}`);
  mkdirSync(dir);
  for (const [name, version, licence] of installs) {
    mkdirSync(path.join(dir, name, 'Contents', 'Resources'), { recursive: true });
    if (version) writeFileSync(path.join(dir, name, 'Contents', 'version.plist'), toPlistXml({ CFBundleShortVersionString: version }));
    if (licence) writeFileSync(path.join(dir, name, 'Contents', 'Resources', 'LicenseInfo.plist'), toPlistXml({ licenseType: licence }));
  }
  for (const [link, target] of links) symlinkSync(target, path.join(dir, link));
  return dir;
}

function select(dir) {
  const result = spawnSync('bash', [script], {
    env: { ...process.env, XCODE_SEARCH_DIR: dir, PLISTBUDDY: plistBuddy },
    encoding: 'utf8',
  });
  return { status: result.status, chosen: result.stdout.trim(), log: result.stderr };
}

test('picks the newest stable Xcode from the layout of a GitHub macOS runner', () => {
  // Folder names and links as listed in the macos-26 runner image's README on 2026-11-13.
  const dir = applications(
    [
      ['Xcode_26.0.1.app', '26.0.1', 'GM'],
      ['Xcode_26.1.1.app', '26.1.1', 'GM'],
      ['Xcode_26.2.app', '26.2', 'GM'],
      ['Xcode_26.3.app', '26.3', 'GM'],
      ['Xcode_26.4.1.app', '26.4.1', 'GM'],
      ['Xcode_26.5.app', '26.5', 'GM'],
      ['Xcode_26.6.app', '26.6', 'GM'],
    ],
    [
      ['Xcode.app', 'Xcode_26.6.app'],
      ['Xcode_26.6.0.app', 'Xcode_26.6.app'],
      ['Xcode_26.4.app', 'Xcode_26.4.1.app'],
    ],
  );
  const result = select(dir);
  assert.equal(result.status, 0, result.log);
  assert.equal(result.chosen, path.join(dir, 'Xcode_26.6.app'));
  assert.equal(result.log.split('\n').filter((line) => line.startsWith('found')).length, 7, 'links are not counted twice');
});

test('betas and release candidates are never chosen, whatever their number', () => {
  const dir = applications([
    ['Xcode_26.6.app', '26.6', 'GM'],
    ['Xcode_27.0_beta_3.app', '27.0', 'Beta'], // beta by name and by licence
    ['Xcode_27.0.app', '27.0', 'Beta'], // beta by licence only
    ['Xcode_26.7_Release_Candidate.app', '26.7', 'GM'], // release candidate by name
  ]);
  const result = select(dir);
  assert.equal(result.status, 0, result.log);
  assert.equal(result.chosen, path.join(dir, 'Xcode_26.6.app'));
});

test('versions are compared as numbers: 26.10 is newer than 26.9, 26.4.1 newer than 26.4', () => {
  const first = applications([
    ['Xcode_26.9.app', '26.9', 'GM'],
    ['Xcode_26.10.app', '26.10', 'GM'],
    ['Xcode_9.4.1.app', '9.4.1', 'GM'],
  ]);
  assert.equal(select(first).chosen, path.join(first, 'Xcode_26.10.app'));
  const second = applications([
    ['Xcode_26.4.1.app', '26.4.1', null], // no licence file: treated as stable
    ['Xcode_26.4.app', '26.4', 'GM'],
  ]);
  assert.equal(select(second).chosen, path.join(second, 'Xcode_26.4.1.app'));
});

test('a folder name with a space, other apps and broken copies are handled', () => {
  const dir = applications([
    ['Xcode 26.6.app', '26.6', 'GM'],
    ['Xcode_26.5.app', '26.5', 'GM'],
    ['Xcode_broken.app', null, null],
    ['Safari.app', '26.0', null],
  ]);
  const result = select(dir);
  assert.equal(result.status, 0, result.log);
  assert.equal(result.chosen, path.join(dir, 'Xcode 26.6.app'));
});

test('it fails, rather than guessing, when no stable Xcode is installed', () => {
  const none = select(applications([['Safari.app', '26.0', null]]));
  assert.equal(none.status, 1);
  assert.equal(none.chosen, '');
  const onlyBeta = select(applications([['Xcode_27.0_beta.app', '27.0', 'Beta']]));
  assert.equal(onlyBeta.status, 1);
  assert.match(onlyBeta.log, /No stable Xcode/);
});
