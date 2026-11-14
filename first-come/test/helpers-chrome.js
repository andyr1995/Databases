// A page in a real (headless) Chrome, for the few things no stand-in DOM can show.
//
// No browser-automation package is involved: Chrome is started with a debugging port and
// driven over its DevTools protocol through Node's own WebSocket. Chrome is looked for in
// CHROME_BIN, on the PATH and in the usual macOS place; where there is none, or it will not
// start or answer, `runInChrome` says so and the caller skips its test. That is on purpose:
// these tests add proof where a browser is at hand, and must never be the reason a build
// machine without one turns red.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];
const MAC_APPS = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];

/** The Chrome to use, or null. */
export function findChrome(env = process.env) {
  if (env.CHROME_BIN) return existsSync(env.CHROME_BIN) ? env.CHROME_BIN : null;
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of NAMES) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return MAC_APPS.find((candidate) => existsSync(candidate)) ?? null;
}

/** Thrown when the browser could not be used at all; never for what the page itself did. */
export class ChromeUnavailable extends Error {}

/**
 * Opens `url` in a phone-sized headless Chrome, waits for it to load, evaluates `expression`
 * there (it may be a promise) and returns its value.
 *
 * @throws {ChromeUnavailable} if there is no Chrome, or it does not start, load or answer in time
 * @throws {Error} if the expression itself throws in the page
 */
export async function runInChrome(url, expression, { timeoutMs = 20_000 } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new ChromeUnavailable('no Chrome or Chromium found (CHROME_BIN, the PATH, /Applications)');
  if (typeof WebSocket !== 'function') throw new ChromeUnavailable('this Node has no WebSocket');

  const profile = mkdtempSync(path.join(os.tmpdir(), 'bridge-chrome-'));
  const child = spawn(
    chrome,
    // --no-sandbox: Chrome refuses to start as root otherwise, and the page is the test's own file.
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let socket = null;
  /** Asks Chrome to quit by itself; set once the DevTools connection is up. */
  let quit = null;
  const within = (promise, what) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ChromeUnavailable(`${what} took longer than ${timeoutMs} ms`)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });

  try {
    const endpoint = await within(
      new Promise((resolve, reject) => {
        let output = '';
        child.stderr.on('data', (chunk) => {
          output += chunk;
          const found = /DevTools listening on (ws:\/\/\S+)/.exec(output);
          if (found) resolve(found[1]);
        });
        child.on('error', (error) => reject(new ChromeUnavailable(`${chrome} could not be started: ${error.message}`)));
        child.on('exit', (code) => reject(new ChromeUnavailable(`${chrome} exited at once (${code}): ${output.trim().split('\n').pop() ?? ''}`)));
      }),
      'starting Chrome',
    );

    socket = new WebSocket(endpoint);
    await within(
      new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new ChromeUnavailable('the DevTools connection could not be opened'));
      }),
      'connecting to Chrome',
    );

    let nextId = 1;
    const answers = new Map();
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.id === undefined || !answers.has(data.id)) return; // an event: none is needed here
      const { resolve, reject } = answers.get(data.id);
      answers.delete(data.id);
      if (data.error) reject(new ChromeUnavailable(`Chrome refused a command: ${data.error.message}`));
      else resolve(data.result);
    };
    const send = (method, params = {}, sessionId) =>
      within(
        new Promise((resolve, reject) => {
          const id = nextId++;
          answers.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params, sessionId }));
        }),
        method,
      );
    quit = () => send('Browser.close');

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
    await send('Page.navigate', { url }, sessionId);
    // Wait until it is this page that has loaded (a load event could still be about:blank's).
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await send('Runtime.evaluate', { expression: 'location.href + " " + document.readyState', returnByValue: true }, sessionId);
      if (state.result?.value === `${url} complete`) break;
      if (Date.now() > deadline) throw new ChromeUnavailable(`the page did not load within ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const answer = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (answer.exceptionDetails) {
      const thrown = answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text;
      throw new Error(`The page threw: ${thrown}`);
    }
    return answer.result.value;
  } finally {
    // Chrome is asked to quit by itself, so that its helper processes stop writing to the
    // profile folder; killed if it has not gone after two seconds. Nothing here may turn a
    // test red: a profile folder that cannot be removed yet is left in the temporary folder.
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', resolve);
    });
    try {
      await quit?.();
    } catch {
      /* it is killed below */
    }
    try {
      socket?.close();
    } catch {
      /* already gone */
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* see above */
    }
  }
}
