/// <reference types="@capacitor/splash-screen" />
import type { CapacitorConfig } from '@capacitor/cli';
// app.config.json is the single source of truth for the app's identity and for the
// location of the web app. Nothing here repeats a value from it.
import appConfig from './app.config.json' with { type: 'json' };

const config: CapacitorConfig = {
  appId: appConfig.appId,
  appName: appConfig.appName,
  webDir: appConfig.webDir,

  ios: {
    // Full-bleed: the web view covers the whole screen, under the status bar and the home
    // indicator, and never adds insets of its own. The game keeps clear of the notch and the
    // home indicator itself with env(safe-area-inset-*) in CSS (its page declares
    // viewport-fit=cover). The bridge relies on this too: it reads env(safe-area-inset-bottom)
    // to report how far the ad banner reaches up from the bottom of the screen.
    contentInset: 'never',
  },

  plugins: {
    SplashScreen: {
      // The launch screen stays up until the game calls platform.appReady(), which the bridge
      // turns into SplashScreen.hide(). The two settings below are the safety net: a native
      // timer that removes the launch screen after 5 s even if no JavaScript ever runs (a
      // script error, a missing file). An earlier hide() from the game simply wins; the
      // timer then finds nothing to hide.
      launchAutoHide: true,
      launchShowDuration: 5000,
    },
  },
};

export default config;
