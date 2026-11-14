/// <reference types="@capacitor/splash-screen" />
import type { CapacitorConfig } from '@capacitor/cli';
// app.config.json is the single source of truth for the app's identity and for the
// location of the web app. Nothing here repeats a value from it.
import appConfig from './app.config.json' with { type: 'json' };
// The colours of the Android launch screen and system bars, written by the art script.
import androidColors from './resources/android/colors.json' with { type: 'json' };

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

  android: {
    // What the web view shows before the page has painted, and around the page while it
    // loads: the colour of the launch screen and of the game's own background, instead of
    // white. (Android only on purpose: iPhone keeps its launch storyboard and system colour.)
    backgroundColor: androidColors.splashBackground,
  },

  plugins: {
    // Capacitor's own plugin for the status bar and navigation bar. It reads `style` on
    // both systems; the other two keys are Android only.
    SystemBars: {
      // Light icons and text in the bars, because the game is dark whatever the phone's
      // theme is. On iPhone this is what the forced dark appearance already gives.
      style: 'DARK',
      // Android. 'css' is the default, spelled out because the game's stylesheet and the
      // bridge depend on it. On a WebView older than 140, where env(safe-area-inset-*) is not
      // to be trusted, Capacitor pads the web view clear of the system bars and sets
      // --safe-area-inset-* to 0px. From 140 on, a page with viewport-fit=cover runs edge to
      // edge and the variables (and env()) hold the real insets. So a page has to read the
      // insets as var(--safe-area-inset-*, env(safe-area-inset-*, 0px)): the bridge does,
      // when it works out how far the ad banner reaches up (src/bridge/viewport.ts), and the
      // game's stylesheet must do the same for --safe-top and --safe-bottom.
      // All of this assumes a window that is edge to edge, which on Android 14 and earlier
      // an app has to ask for: MainActivity does (written by scripts/configure-android.mjs).
      // Never 'disable': the AdMob plugin and the bridge both build on this handling.
      insetsHandling: 'css',
      // The page declares viewport-fit=cover. Saying so up front spares WebView 140+ a
      // first layout with padding that is dropped as soon as the page has been inspected.
      initialViewportFitValueHint: 'cover',
    },

    SplashScreen: {
      // The launch screen stays up until the game calls platform.appReady(), which the bridge
      // turns into SplashScreen.hide(). The two settings below are the safety net: a native
      // timer that removes the launch screen after 5 s even if no JavaScript ever runs (a
      // script error, a missing file). An earlier hide() from the game simply wins; the
      // timer then finds nothing to hide. Android behaves the same way: its system splash
      // screen is held until hide() or this timer, whichever comes first.
      launchAutoHide: true,
      launchShowDuration: 5000,
    },
  },
};

export default config;
