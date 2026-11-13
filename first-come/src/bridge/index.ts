// Entry point of vendor/native-bridge.js.
//
// Inside the Capacitor shell the game's js/platform.js runs
//   const bridge = await import('../vendor/native-bridge.js'); await bridge.install(platform);
// This is the only module that imports the real plugins and the app configuration;
// everything else receives them as parameters.

import { AdMob } from '@capacitor-community/admob';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { Haptics } from '@capacitor/haptics';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import { SplashScreen } from '@capacitor/splash-screen';
import { NativePurchases } from '@capgo/native-purchases';
import appConfig from '../../app.config.json' with { type: 'json' };
import { installBridge } from './install.ts';
import { browserLegacyStorage } from './persist.ts';
import type { Platform } from './types.ts';
import { browserViewport } from './viewport.ts';

const installed = new WeakSet<object>();

/**
 * Replace the web behaviour of `platform` with the native implementations.
 * Safe to call twice with the same object; the second call does nothing.
 */
export async function install(platform: Platform): Promise<void> {
  if (!platform || typeof platform !== 'object') throw new TypeError('install(platform): platform object expected');
  if (installed.has(platform)) return;
  installed.add(platform);

  installBridge(platform, {
    os: Capacitor.getPlatform(),
    // Only what the bridge needs is taken from app.config.json; ids and the testing flag
    // are fixed at build time.
    config: { admob: appConfig.admob, iap: appConfig.iap },
    plugins: {
      admob: AdMob,
      app: App,
      browser: Browser,
      haptics: Haptics,
      preferences: Preferences,
      purchases: NativePurchases,
      share: Share,
      splash: SplashScreen,
    },
    legacyStorage: browserLegacyStorage(),
    viewport: browserViewport(),
  });
}
