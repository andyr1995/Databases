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
//  removeBanner removes the view. Emits nothing.
//  Before AdMob.initialize() the executors have no plugin reference, and showBanner /
//  resumeBanner then never settle. The controller therefore does nothing until canLoad().

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
  /** env(safe-area-inset-bottom) in CSS px: the home-indicator gap the banner sits above. */
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
}

export const DEFAULT_BANNER_TUNING: BannerTuning = {
  retryBaseMs: 10_000,
  retryCapMs: 5 * 60_000,
  loadTimeoutMs: 45_000,
  relayoutDelayMs: 300,
};

export interface BannerHost {
  clock: Clock;
  log: Logger;
  tuning: BannerTuning;
  viewport: Viewport;
  /** Consent is settled and the SDK is running. */
  canLoad(): boolean;
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
   * area (margin 0), so that is the banner's own height plus the home-indicator inset.
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
    attempt(() => driver.create()).catch((error) => {
      if (id === requestId && phase === 'pending') failed(error);
    });
  }

  function resume(): void {
    phase = 'pending';
    const id = ++requestId;
    watchLoad(id);
    attempt(() => driver.resume()).then(
      () => {
        // The size event normally got here first; this covers its absence.
        if (id === requestId && phase === 'pending') appeared();
      },
      () => {
        // "not find subView": the plugin removed the view (a refresh failed while it was hidden).
        if (id !== requestId || phase !== 'pending') return;
        loadTimer = cancel(loadTimer);
        phase = 'none';
        nativeHeight = 0;
        apply();
      },
    );
  }

  function hide(): void {
    phase = 'hidden';
    attempt(() => driver.hide()).catch((error) => log('hideBanner failed', error));
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

  function failed(error?: unknown): void {
    loadTimer = cancel(loadTimer);
    phase = 'none'; // on a load failure the plugin has removed the view
    nativeHeight = 0;
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
      attempt(() => driver.remove()).catch((error) => log('removeBanner failed', error));
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
        emit();
      }
    },
    handleLoaded() {
      appeared();
    },
    handleFailed(error) {
      failed(error);
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
  };
}
