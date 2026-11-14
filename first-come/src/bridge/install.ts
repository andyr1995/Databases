import { type AdMobLike, createAdsProvider, createUnavailableAds } from './ads.ts';
import { type AppLike, createActivityWatch, createAppState, createOnBack } from './app-state.ts';
import type { Viewport } from './banner.ts';
import { type BridgeConfig, resolveAdUnits } from './config.ts';
import { createHaptic, type HapticsLike } from './haptics.ts';
import { createIapProvider, type PurchasesLike } from './iap.ts';
import { createPersist, type LegacyStorage, type PreferencesLike } from './persist.ts';
import { createShare, type ShareLike } from './share.ts';
import { type BrowserLike, createAppReady, createOpenExternal, type SplashLike } from './system.ts';
import type { Platform } from './types.ts';
import { type Clock, consoleLogger, type Logger } from './util.ts';

export interface BridgePlugins {
  admob: AdMobLike;
  app: AppLike;
  browser: BrowserLike;
  haptics: HapticsLike;
  preferences: PreferencesLike;
  purchases: PurchasesLike;
  share: ShareLike;
  splash: SplashLike;
}

export interface BridgeDeps {
  /** Capacitor.getPlatform(): 'ios' | 'android' | 'web' */
  os: string;
  config: BridgeConfig;
  plugins: BridgePlugins;
  /** window.localStorage, for migrating saves made before the bridge existed. */
  legacyStorage?: LegacyStorage | null;
  viewport?: Viewport;
  clock?: Clock;
  log?: Logger;
}

/**
 * Swap the native implementations into the game's `platform` object. Everything the bridge
 * touches comes in through `deps`, so this runs unchanged under test with fake plugins.
 *
 * This only wires things up: nothing is awaited, and the only plugin calls made are App
 * listener registrations (the app state; on Android also the activity's pause and resume,
 * and Back, which must work before the game has got as far as asking for it).
 * The ad SDK starts when the game calls platform.ads.init().
 */
export function installBridge(platform: Platform, deps: BridgeDeps): void {
  const { config, plugins } = deps;
  const log = deps.log ?? consoleLogger;

  const onActive = createAppState(plugins.app, log);
  const persist = createPersist(plugins.preferences, deps.legacyStorage ?? null, log);
  const units = resolveAdUnits(config.admob, deps.os);

  platform.isNative = true;
  platform.os = deps.os;
  platform.haptic = createHaptic(plugins.haptics);
  platform.share = createShare(plugins.share);
  platform.openExternal = createOpenExternal(plugins.browser, log);
  platform.appReady = createAppReady(plugins.splash, log);
  platform.persist = persist;
  platform.onActiveChange = onActive;
  platform.onBack = createOnBack(plugins.app, deps.os, log);
  platform.ads = units
    ? createAdsProvider({
        admob: plugins.admob,
        os: deps.os,
        units,
        testing: config.admob.testing,
        onActive,
        onActivity: createActivityWatch(plugins.app, deps.os, log),
        store: persist,
        viewport: deps.viewport,
        clock: deps.clock,
        log,
      })
    : createUnavailableAds();
  platform.iap = createIapProvider(plugins.purchases, config.iap.removeAdsProductId, {
    os: deps.os,
    onActive,
    clock: deps.clock,
    log,
  });
}
