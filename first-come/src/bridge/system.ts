import type { BrowserPlugin } from '@capacitor/browser';
import type { SplashScreenPlugin } from '@capacitor/splash-screen';
import { attempt, type Logger, noop } from './util.ts';

export type BrowserLike = Pick<BrowserPlugin, 'open'>;
export type SplashLike = Pick<SplashScreenPlugin, 'hide'>;

/**
 * platform.openExternal(url): an absolute https URL in the in-app browser
 * (SFSafariViewController on iOS; on Android a Chrome Custom Tab of the player's browser,
 * closed with Back), so the player never leaves the game.
 * Anything that is not an absolute https URL is ignored. Never throws.
 *
 * Android (BrowserPlugin.java, 8.0.5): open() resolves once the tab is launched and rejects
 * "Unable to display URL" when the phone has no browser at all. While the tab is open the
 * game's activity is stopped, so the game is told it is no longer active.
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
 *
 * Android (SplashScreen.java, 8.0.2): the launch screen is the system splash screen
 * (androidx.core.splashscreen, so the activity's launch theme must descend from
 * Theme.SplashScreen). The plugin keeps it up by refusing to draw the activity until hide()
 * is called or launchShowDuration has passed; the page loads and runs meanwhile. Its fade
 * always takes launchFadeOutDuration (200 ms unless configured): the fadeOutDuration sent
 * here is ignored for the launch screen, and any value other than 200 only logs a warning.
 */
export function createAppReady(splash: SplashLike, log: Logger = noop): () => void {
  return () => {
    attempt(() => splash.hide({ fadeOutDuration: 200 })).catch((error) => log('SplashScreen.hide failed', error));
  };
}
