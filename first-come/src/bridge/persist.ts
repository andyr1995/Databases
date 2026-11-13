import type { PreferencesPlugin } from '@capacitor/preferences';
import type { Persist } from './types.ts';
import { attempt, type Logger, noop } from './util.ts';

export type PreferencesLike = Pick<PreferencesPlugin, 'get' | 'set'>;

/** The slice of window.localStorage the migration needs. Every call may throw. */
export interface LegacyStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/**
 * platform.persist backed by @capacitor/preferences (UserDefaults on iOS), which unlike
 * the web view's localStorage is not purged by the system when storage runs low.
 *
 * Migration: the first time a key is read that Preferences does not have but localStorage
 * does (a save made before the bridge existed, or while it failed to load), the value is
 * copied into Preferences and returned. The localStorage copy is removed only after
 * Preferences confirmed the write, so a failed write leaves it to be migrated next time.
 *
 * get() resolves null when the key is absent. Neither call rejects.
 */
export function createPersist(preferences: PreferencesLike, legacy: LegacyStorage | null, log: Logger = noop): Persist {
  const readLegacy = (key: string): string | null => {
    if (!legacy) return null;
    try {
      const value = legacy.getItem(key);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  };

  return {
    async get(key) {
      let preferencesWork = true;
      try {
        const result = await attempt(() => preferences.get({ key }));
        const value = result ? result.value : null;
        if (typeof value === 'string') return value;
      } catch (error) {
        preferencesWork = false;
        log(`Preferences.get failed for "${key}"`, error);
      }

      const old = readLegacy(key);
      if (old === null) return null;
      if (preferencesWork) {
        try {
          await attempt(() => preferences.set({ key, value: old }));
          try {
            legacy?.removeItem(key);
          } catch {
            /* the copy in Preferences now wins anyway */
          }
        } catch (error) {
          log(`Could not migrate "${key}" to Preferences`, error);
        }
      }
      return old;
    },

    async set(key, value) {
      try {
        await attempt(() => preferences.set({ key, value: String(value) }));
      } catch (error) {
        log(`Preferences.set failed for "${key}"`, error);
      }
    },
  };
}

/** window.localStorage, or null where touching it throws (it can, in a locked-down web view). */
export function browserLegacyStorage(): LegacyStorage | null {
  try {
    const storage = globalThis.localStorage;
    return storage ? storage : null;
  } catch {
    return null;
  }
}
