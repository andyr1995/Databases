// Locates the web app's modules for the tests. Set GAME_WEB_DIR to test another copy.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
function findWebDir() {
  if (process.env.GAME_WEB_DIR) return resolve(process.env.GAME_WEB_DIR);
  // <wrapper>/test/game/_web.js -> <wrapper>/app.config.json names the web dir.
  const config = resolve(here, '../../app.config.json');
  if (existsSync(config)) return resolve(dirname(config), JSON.parse(readFileSync(config, 'utf8')).webDir);
  return resolve(here, '../../stage');
}
export const webDir = findWebDir();
export const load = (name) => import(pathToFileURL(join(webDir, 'js', name)).href);
