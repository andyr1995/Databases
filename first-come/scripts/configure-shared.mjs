// What scripts/configure-ios.mjs and scripts/configure-android.mjs have in common: the error
// they report, two small checks, and the last step, where the files they have worked out are
// compared with what is on disk and written if they differ.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** A problem the person running the script can fix. Reported as one message, without a stack trace. */
export class ConfigureError extends Error {}

export function xmlText(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Where two texts first differ, for an error message. */
export function firstDifference(a, b) {
  const left = a.split('\n');
  const right = b.split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) return `line ${i + 1}: "${(left[i] ?? '').trim()}" would become "${(right[i] ?? '').trim()}"`;
  }
  return 'no difference';
}

/** Size and transparency of a PNG image (no image library: only the header is read). */
export function readPngInfo(buffer, label) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature) || buffer.toString('latin1', 12, 16) !== 'IHDR') {
    throw new ConfigureError(`${label} is not a PNG file.`);
  }
  const colourType = buffer[25];
  let transparency = colourType === 4 || colourType === 6;
  // A palette or plain image can still mark colours as transparent with a tRNS chunk.
  for (let offset = 8; offset + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (type === 'tRNS') transparency = true;
    if (type === 'IDAT' || type === 'IEND') break;
    offset += 12 + length;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), transparency };
}

/**
 * Compares the wanted files with what is on disk and, unless `check` is set, writes the ones
 * that differ and deletes the ones that should no longer exist.
 *
 * @param {string} root                         Paths in the result are relative to this folder.
 * @param {Map<string, string | Buffer>} plan   Absolute path -> wanted content.
 * @param {object} [options]
 * @param {boolean} [options.check]             Write and delete nothing; only report.
 * @param {Iterable<string>} [options.remove]   Absolute paths of files that must not exist. A
 *                                              folder left empty by a deletion is removed too.
 * @returns {{changed: string[], unchanged: string[], removed: string[]}}
 *          `changed` lists every file that is out of date, the ones to delete included;
 *          `removed` lists only those. Forward slashes.
 */
export function applyPlan(root, plan, { check = false, remove = [] } = {}) {
  const relative = (file) => path.relative(root, file).split(path.sep).join('/');
  const changed = [];
  const unchanged = [];
  const removed = [];
  for (const [file, wanted] of plan) {
    const content = Buffer.isBuffer(wanted) ? wanted : Buffer.from(wanted, 'utf8');
    if (existsSync(file) && readFileSync(file).equals(content)) {
      unchanged.push(relative(file));
      continue;
    }
    changed.push(relative(file));
    if (!check) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
  for (const file of remove) {
    if (plan.has(file) || !existsSync(file)) continue;
    changed.push(relative(file));
    removed.push(relative(file));
    if (check) continue;
    rmSync(file);
    for (let dir = path.dirname(file); dir.startsWith(root + path.sep) && readdirSync(dir).length === 0; dir = path.dirname(dir)) {
      rmdirSync(dir);
    }
  }
  return { changed, unchanged, removed };
}
