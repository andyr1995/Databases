// Small helpers shared by the bridge modules. Nothing here touches a plugin or the DOM.

/** Injectable time source, so the ad state machines can be tested without waiting. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type Logger = (message: string, detail?: unknown) => void;

export const consoleLogger: Logger = (message, detail) => {
  try {
    if (detail === undefined) console.warn(`[native-bridge] ${message}`);
    else console.warn(`[native-bridge] ${message}`, detail);
  } catch {
    /* logging must never break the game */
  }
};

/**
 * The string value of a string-enum member, checked by the compiler against the
 * plugin's own typings, without importing the plugin's JavaScript.
 *
 *   enumValue<BannerAdPluginEvents.SizeChanged>('bannerAdSizeChanged')
 *
 * A typo, or a plugin release that renames the event, is a type error.
 */
export function enumValue<E extends string>(value: `${E}`): E {
  return value as unknown as E;
}

/** Delay before retry number `failures` (1-based): base, 2x base, 4x base ... never more than cap. */
export function backoffDelay(failures: number, baseMs: number, capMs: number): number {
  const exponent = Math.min(Math.max(failures, 1) - 1, 30);
  return Math.min(capMs, baseMs * 2 ** exponent);
}

/** Run `fn` so that a synchronous throw becomes a rejection. */
export function attempt<T>(fn: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => resolve(fn()));
}

/** Reject if `promise` has not settled after `ms`. The underlying work is not cancelled. */
export function withTimeout<T>(clock: Clock, promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clock.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clock.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Best-effort text of whatever a plugin rejected with. */
export function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; errorMessage?: unknown };
    if (typeof e.message === 'string' && e.message) return e.message;
    if (typeof e.errorMessage === 'string' && e.errorMessage) return e.errorMessage;
  }
  return '';
}

export const noop = (): void => {};
