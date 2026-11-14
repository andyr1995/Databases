// The banner: one adaptive banner anchored at the bottom, shown and hidden as the game asks,
// plus the height the game must keep clear for it.
//
// What the plugin does on iOS, read from @capacitor-community/admob 8.3.0
// (ios/Sources/AdMobPlugin/Banner/BannerExecutor.swift):
//
//  showBanner   creates a BannerView sized for the CURRENT width (safe-area width) and starts
//               loading. It resolves straight away. The view is only added to the screen
//               when the ad has loaded: bannerViewDidReceiveAd adds it to the root view
//               (which in Capacitor is the web view itself), centred, with its BOTTOM edge
//               pinned to safeAreaLayoutGuide.bottom minus `margin`. So the banner sits
//               ABOVE the home-indicator area, never inside it. Then it emits
//               bannerAdSizeChanged { width, height } and bannerAdLoaded.
//               width/height are the banner view's own frame in points (= CSS px). The
//               safe-area gap under the banner is NOT included.
//               The same two events fire again on every automatic refresh.
//  load failure (first load or a refresh) removes the view, emits bannerAdSizeChanged {0,0}
//               and bannerAdFailedToLoad.
//  hideBanner   sets isHidden on the view if it is on screen, emits bannerAdSizeChanged {0,0}.
//               If the ad has not loaded yet there is nothing to hide, and the banner still
//               appears when the load completes.
//  resumeBanner un-hides and emits bannerAdSizeChanged {w,h}; rejects if the view is gone.
//  removeBanner removes the view if it is on screen (hidden or not). Emits nothing and
//               always resolves, also when there is no view.
//  Before AdMob.initialize() the executors have no plugin reference, and showBanner /
//  resumeBanner then never settle. The controller therefore does nothing until canLoad().
//
// Two more facts the controller is built around (AdMobPlugin.swift, and Capacitor's
// WebViewDelegationHandler.swift / CAPBridgeViewController.swift):
//
//  Order.   Every banner call is passed to the main queue once, but hideBanner then passes
//           itself on a second time before it acts. A hideBanner followed straight away by a
//           resumeBanner can therefore be applied the other way round. The controller sends
//           its calls one at a time, each after the previous one has answered (see send()).
//  Reload.  The banner is a native subview of the web view, owned by the plugin instance.
//           Both outlive the page: when the page is loaded again (iOS discarded the web
//           content process in the background, or location.reload()) Capacitor only drops
//           the listeners. A banner the previous page put up is then still on screen, over a
//           page that knows nothing about it. clearLeftover() takes it down.

//
// What the plugin does on Android, read from the same version (android/src/main/java/com/
// getcapacitor/community/admob/banner/BannerExecutor.java, BannerAdSizeInfo.kt, AdMob.java).
// The controller runs with `android: true` there; each difference it acts on is marked (A).
//
//  showBanner   creates an AdView with the anchored adaptive size for the display width and
//               puts it into a wrapper that is added AT ONCE to the web view's parent (the
//               CoordinatorLayout of Capacitor's activity), bottom-aligned, on top of the web
//               view. Nothing is visible until the ad has loaded. It resolves straight away.
//               When loaded it emits bannerAdSizeChanged { width, height } and bannerAdLoaded,
//               and again on every refresh. width/height are AdSize.getWidth()/getHeight():
//               dp, which is CSS px in the web view. As on iOS the gap under the banner is
//               NOT included.
//               (A) If the plugin still holds an AdView (mAdView != null: one that is loading,
//               hidden, or left by an earlier page) showBanner only reloads that view and
//               NEVER ANSWERS. So a view the plugin may still hold is removed before a new
//               one is asked for (dropNative()).
//  where it sits  the wrapper's bottom margin is `margin` plus the bottom system-bar /
//               cutout inset that reaches it. Capacitor's SystemBars plugin (SystemBars.java)
//               decides what reaches it: on a WebView older than 140 it pads the whole
//               window content clear of the system bars and passes 0 down, so the banner
//               sits on the bottom edge of the web view; from WebView 140 on, with
//               viewport-fit=cover, the web view runs edge to edge under the navigation bar
//               and the banner is lifted above the bar (3-button or gesture) by that inset.
//               Either way the gap under the banner is the bottom safe-area inset of the
//               page, which is what Viewport.safeAreaBottom() reads, so height() below holds
//               on both systems.
//               This rests on the window being edge to edge. SystemBars tells the page the
//               bar heights (--safe-area-inset-*) whether or not it is, but in a window that
//               is not, Android itself keeps the content clear of the bars and no inset
//               reaches the wrapper: height() would be too large by the navigation bar. An
//               app that targets Android 15+ is edge to edge on Android 15+ by itself; on
//               Android 14 and earlier MainActivity asks for it (EdgeToEdge.enable, written
//               by scripts/configure-android.mjs, which refuses a MainActivity without it).
//  load failure (first load or a refresh) removes the view and forgets it, emits
//               bannerAdSizeChanged {0,0} and bannerAdFailedToLoad. Same as iOS.
//  hideBanner   hides the wrapper, pauses the AdView (no refreshes while hidden), emits
//               {0,0}, and resolves from the UI thread once that is done. It REJECTS when
//               there is no AdView. The controller only hides a banner that is on screen.
//  resumeBanner (A) resolves at once, before it has acted, and also when there is no view
//               (iOS rejects then). The proof that the banner is back is the
//               bannerAdSizeChanged {w,h} it emits after un-hiding.
//  removeBanner removes and destroys the AdView, loading or loaded, hidden or not, and emits
//               {0,0}. It always resolves, (A) and it resolves BEFORE the removal has
//               happened on the UI thread. A showBanner sent on that answer can still find
//               the old view and fall into the never-answering path above. ads.ts therefore
//               wraps the Android driver's remove() so that it only answers once the {0,0}
//               has arrived (or removeSettleMs has passed, when there was nothing to remove).
//  Order.       Plugin calls run one after another on one background thread and hand their
//               work to the UI thread in that order, so hide and resume cannot overtake
//               each other as on iOS. Sending them one at a time is still right: see above.
//  Reload.      As on iOS the plugin instance and its banner outlive the page (Bridge.reset()
//               only drops the listeners), so clearLeftover() is needed here too. On Android
//               it also finds a leftover that was still loading.
//  initialize() need not have run for any of these calls, but the controller waits for
//               canLoad() on both systems.

import { attempt, backoffDelay, type Clock, type Logger } from './util.ts';

export interface BannerDriver {
  /** AdMob.showBanner(...) with the adaptive size, bottom position and margin 0. */
  create(): Promise<unknown>;
  hide(): Promise<unknown>;
  resume(): Promise<unknown>;
  remove(): Promise<unknown>;
}

/** What the controller needs to know about the web view. */
export interface Viewport {
  /**
   * The bottom safe-area inset of the page in CSS px: the gap the banner sits above (the
   * home indicator on iPhone, the navigation bar on an edge-to-edge Android web view).
   */
  safeAreaBottom(): number;
  /** Width of the layout viewport in CSS px. */
  width(): number;
  /** Call `cb` whenever the size or the safe area of the viewport may have changed. */
  onChange(cb: () => void): void;
}

export const NO_VIEWPORT: Viewport = { safeAreaBottom: () => 0, width: () => 0, onChange: () => {} };

export interface BannerTuning {
  retryBaseMs: number;
  retryCapMs: number;
  /** No Loaded and no FailedToLoad after this long counts as a failure. */
  loadTimeoutMs: number;
  /** Wait this long after a width change (rotation) before rebuilding the banner. */
  relayoutDelayMs: number;
  /** A plugin call waits at most this long for the call before it to answer. */
  callWaitMs: number;
  /** Android: after resumeBanner has answered, how long to wait for the size event that proves the banner is back. */
  resumeConfirmMs: number;
  /** Android: how long removeBanner is given to report that the view is gone (see ads.ts). */
  removeSettleMs: number;
}

export const DEFAULT_BANNER_TUNING: BannerTuning = {
  retryBaseMs: 10_000,
  retryCapMs: 5 * 60_000,
  loadTimeoutMs: 45_000,
  relayoutDelayMs: 300,
  callWaitMs: 5_000,
  resumeConfirmMs: 2_000,
  removeSettleMs: 500,
};

export interface BannerHost {
  clock: Clock;
  log: Logger;
  tuning: BannerTuning;
  viewport: Viewport;
  /** Consent is settled and the SDK is running. */
  canLoad(): boolean;
  /** The plugin behaves as its Android source does (see the notes at the top of this file). */
  android?: boolean;
}

export interface BannerController {
  /** The game wants (or no longer wants) a banner on the current screen. */
  setWanted(wanted: boolean): void;
  /** Register the single height listener (a later call replaces the earlier one). */
  onHeight(cb: (cssPx: number) => void): void;
  /** bannerAdSizeChanged */
  handleSize(height: number): void;
  /** bannerAdLoaded */
  handleLoaded(): void;
  /** bannerAdFailedToLoad */
  handleFailed(error?: unknown): void;
  /** Something the banner depends on changed (the SDK started, consent changed). */
  refresh(): void;
  /** The app came back to the foreground. */
  onActive(): void;
  /**
   * Take down a banner that an earlier page of this app left on screen (see "Reload" at
   * the top of this file). Call once, before the first refresh().
   */
  clearLeftover(): void;
}

/**
 *  none     no native banner view exists
 *  pending  asked the plugin for a banner (create or resume); waiting for it to appear
 *  visible  loaded and on screen
 *  hidden   loaded, hidden with hideBanner
 */
type Phase = 'none' | 'pending' | 'visible' | 'hidden';

export function createBannerController(driver: BannerDriver, host: BannerHost): BannerController {
  const { clock, log, tuning, viewport } = host;
  const android = host.android === true;

  let wanted = false;
  let phase: Phase = 'none';
  let nativeHeight = 0;
  let builtForWidth = 0;
  let requestId = 0;
  let failures = 0;
  let retryTimer: unknown = null;
  let loadTimer: unknown = null;
  let relayoutTimer: unknown = null;
  let listener: ((cssPx: number) => void) | null = null;
  let lastEmitted = 0;

  const cancel = (timer: unknown): null => {
    if (timer !== null) clock.clearTimeout(timer);
    return null;
  };

  const measure = (read: () => number): number => {
    try {
      const value = read();
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  };

  /**
   * What onBannerHeight reports: the distance from the bottom edge of the screen to the top
   * edge of the banner. The plugin pins the banner's bottom edge to the bottom of the safe
   * area (margin 0), so that is the banner's own height plus the bottom safe-area inset
   * (iPhone: the home indicator; Android: see "where it sits" at the top of this file).
   * 0 whenever there is no banner on screen.
   */
  function height(): number {
    if (!wanted || phase !== 'visible' || nativeHeight <= 0 || !host.canLoad()) return 0;
    return nativeHeight + measure(() => viewport.safeAreaBottom());
  }

  function emit(): void {
    const next = height();
    if (next === lastEmitted) return;
    lastEmitted = next;
    if (!listener) return;
    try {
      listener(next);
    } catch (error) {
      log('The onBannerHeight listener threw', error);
    }
  }

  /** Settles when the plugin call sent last has answered; null while none is under way. */
  let lastCall: Promise<void> | null = null;

  /**
   * Make a plugin call once the call before it has answered, so that the plugin applies
   * them in the order they were made (see "Order" at the top of this file). With no call
   * under way the plugin is called at once.
   *
   * No call waits for ever: showBanner and resumeBanner never answer when the plugin finds
   * no root view controller. After callWaitMs the next call goes out regardless.
   */
  function send(call: () => Promise<unknown>): Promise<unknown> {
    const previous = lastCall;
    let answered: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      answered = resolve;
    });
    lastCall = mine;
    const start = (): Promise<unknown> => {
      const result = attempt(call);
      const done = (): void => {
        answered();
        if (lastCall === mine) lastCall = null;
      };
      result.then(done, done);
      return result;
    };
    if (!previous) return start();
    return new Promise<void>((go) => {
      const timer = clock.setTimeout(go, tuning.callWaitMs);
      void previous.then(() => {
        clock.clearTimeout(timer);
        go();
      });
    }).then(start);
  }

  function watchLoad(id: number): void {
    loadTimer = cancel(loadTimer);
    loadTimer = clock.setTimeout(() => {
      loadTimer = null;
      if (id === requestId && phase === 'pending') failed(new Error('no answer from the ad SDK'));
    }, tuning.loadTimeoutMs);
  }

  function create(): void {
    retryTimer = cancel(retryTimer);
    phase = 'pending';
    nativeHeight = 0;
    builtForWidth = measure(() => viewport.width());
    const id = ++requestId;
    watchLoad(id);
    // The call resolves as soon as the request is under way; success and failure arrive as events.
    send(() => driver.create()).catch((error) => {
      if (id === requestId && phase === 'pending') failed(error);
    });
  }

  /**
   * (A) Android: have the plugin let go of a view it may still hold, so that the next
   * showBanner creates one instead of reloading the old one without answering. On iOS
   * showBanner replaces the view itself, and nothing is sent.
   */
  function dropNative(): void {
    if (!android) return;
    send(() => driver.remove()).catch((error) => log('removeBanner failed', error));
  }

  /** The view that was to be un-hidden is not there any more: start again with a new one. */
  function gone(): void {
    loadTimer = cancel(loadTimer);
    phase = 'none';
    nativeHeight = 0;
    dropNative();
    apply();
  }

  function resume(): void {
    phase = 'pending';
    const id = ++requestId;
    watchLoad(id);
    send(() => driver.resume()).then(
      () => {
        if (id !== requestId || phase !== 'pending') return;
        if (!android) {
          // The size event normally got here first; this covers its absence.
          appeared();
          return;
        }
        // (A) On Android the answer says nothing: it is given before the view is un-hidden,
        // and also when there is no view. Only the size event counts, and it is due now.
        loadTimer = cancel(loadTimer);
        loadTimer = clock.setTimeout(() => {
          loadTimer = null;
          if (id === requestId && phase === 'pending') gone();
        }, tuning.resumeConfirmMs);
      },
      () => {
        // "not find subView": the plugin removed the view (a refresh failed while it was hidden).
        if (id === requestId && phase === 'pending') gone();
      },
    );
  }

  function hide(): void {
    phase = 'hidden';
    send(() => driver.hide()).catch((error) => log('hideBanner failed', error));
  }

  /** Bring the native banner in line with what the game wants. */
  function apply(): void {
    const show = wanted && host.canLoad();
    if (show) {
      if (phase === 'none') create();
      else if (phase === 'hidden') resume();
    } else if (phase === 'visible') {
      hide();
    }
    // 'pending' while not wanted: there is nothing to hide yet. appeared() hides it on arrival.
    emit();
  }

  /** The banner view is on screen now (first load, refresh, or un-hidden). */
  function appeared(): void {
    loadTimer = cancel(loadTimer);
    failures = 0;
    if (phase === 'hidden') {
      // A refresh that was under way when the banner was hidden. The view stays hidden.
      emit();
      return;
    }
    // 'pending' is the normal case. 'none' means a banner we had given up on (timeout) or
    // removed while it was still loading turned up after all: adopt it.
    phase = 'visible';
    if (!(wanted && host.canLoad())) hide(); // the game moved on while it was loading
    emit();
    if (measure(() => viewport.width()) !== builtForWidth) scheduleRelayout();
  }

  /**
   * `removedByPlugin`: the plugin itself reported the failure (bannerAdFailedToLoad), which
   * it does after removing the view. Otherwise the controller gave up on its own (no answer
   * in time, or the showBanner call was rejected) and the plugin may still hold the view.
   */
  function failed(error?: unknown, removedByPlugin = false): void {
    loadTimer = cancel(loadTimer);
    phase = 'none';
    nativeHeight = 0;
    if (!removedByPlugin) dropNative();
    failures++;
    emit();
    retryTimer = cancel(retryTimer);
    if (!wanted) return;
    const delay = backoffDelay(failures, tuning.retryBaseMs, tuning.retryCapMs);
    log(`banner: load failed (${failures} in a row), next try in ${delay} ms`, error);
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      apply();
    }, delay);
  }

  function scheduleRelayout(): void {
    relayoutTimer = cancel(relayoutTimer);
    relayoutTimer = clock.setTimeout(() => {
      relayoutTimer = null;
      if (phase !== 'visible' && phase !== 'hidden') return;
      if (measure(() => viewport.width()) === builtForWidth) return;
      // An adaptive banner is sized once, for the width at creation. After a rotation (or an
      // iPad split-view resize) it is the wrong size: replace it.
      send(() => driver.remove()).catch((error) => log('removeBanner failed', error));
      phase = 'none';
      nativeHeight = 0;
      apply();
    }, tuning.relayoutDelayMs);
  }

  try {
    viewport.onChange(() => {
      emit(); // the home-indicator inset differs between portrait and landscape
      if (phase !== 'none' && measure(() => viewport.width()) !== builtForWidth) scheduleRelayout();
    });
  } catch (error) {
    log('Could not watch the viewport', error);
  }

  return {
    setWanted(next) {
      wanted = !!next;
      if (!wanted) retryTimer = cancel(retryTimer);
      apply();
    },
    onHeight(cb) {
      listener = typeof cb === 'function' ? cb : null;
      // A listener that arrives late must not be left believing there is no banner.
      if (listener && lastEmitted !== 0) {
        try {
          listener(lastEmitted);
        } catch (error) {
          log('The onBannerHeight listener threw', error);
        }
      }
    },
    handleSize(h) {
      if (Number.isFinite(h) && h > 0) {
        nativeHeight = h;
        appeared();
      } else {
        // {0,0} follows our own hideBanner, or precedes bannerAdFailedToLoad. Both are handled
        // where they originate, so this never changes state; it only re-checks the height.
        // (It cannot belong to a hide that the plugin applied after a later resume: send()
        // keeps the calls in order.)
        emit();
      }
    },
    handleLoaded() {
      appeared();
    },
    handleFailed(error) {
      failed(error, true);
    },
    refresh() {
      apply();
    },
    onActive() {
      if (wanted && phase === 'none') {
        retryTimer = cancel(retryTimer);
        apply();
      }
    },
    clearLeftover() {
      // Nothing has been asked of the plugin yet, so any banner view it holds is not ours.
      // On a cold start there is none and the plugin resolves without doing anything. A
      // leftover that was still loading is not found by removeBanner; if it turns up later,
      // appeared() adopts it and hides it unless the game wants a banner by then.
      if (phase !== 'none') return;
      send(() => driver.remove()).catch((error) => log('removeBanner failed', error));
    },
  };
}
