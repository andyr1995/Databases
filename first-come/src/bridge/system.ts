import type { BrowserPlugin } from '@capacitor/browser';
import type { SplashScreenPlugin } from '@capacitor/splash-screen';
import { attempt, type Logger, noop } from './util.ts';

export type BrowserLike = Pick<BrowserPlugin, 'open'>;
export type SplashLike = Pick<SplashScreenPlugin, 'hide'>;

/**
 * platform.openExternal(url): an absolute https URL in the in-app browser
 * (SFSafariViewController on iOS), so the player never leaves the game.
 * Anything that is not an absolute https URL is ignored. Never throws.
 */
export function createOpenExternal(browser: BrowserLike, log: Logger = noop): (url: string) => void {
  return (url) => {
    let target: string;
    try {
      const parsed = new URL(String(url));
      if (parsed.protocol !== 'https:') {
        log(`openExternal ignored a non-https URL: ${String(url)}`);
        return;
      }
      target = parsed.href;
    } catch {
      log(`openExternal ignored an invalid URL: ${String(url)}`);
      return;
    }
    attempt(() => browser.open({ url: target })).catch((error) => log('Browser.open failed', error));
  };
}

/**
 * platform.appReady(): the first screen is drawn, fade the launch screen out.
 * If this is never called (a script error before the first render), the native timer
 * configured in capacitor.config.ts removes the launch screen anyway.
 */
export function createAppReady(splash: SplashLike, log: Logger = noop): () => void {
  return () => {
    attempt(() => splash.hide({ fadeOutDuration: 200 })).catch((error) => log('SplashScreen.hide failed', error));
  };
}
