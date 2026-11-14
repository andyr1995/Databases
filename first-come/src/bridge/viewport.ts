import type { Viewport } from './banner.ts';

/**
 * The bottom safe-area inset as the game's own stylesheet must write it (--safe-bottom).
 *
 * iPhone: Capacitor defines no --safe-area-inset-bottom, so this is env(safe-area-inset-bottom):
 * the home-indicator gap.
 *
 * Android: Capacitor's SystemBars plugin (insetsHandling 'css', the default; SystemBars.java
 * in @capacitor/android 8.6.2) sets --safe-area-inset-* on the root element, and that is the
 * value to trust there:
 *  - WebView older than 140: env() cannot be relied on (it knows about display cutouts only).
 *    SystemBars pads the window content clear of the bars instead and sets the variables to
 *    0px. The AdMob banner then sits on the bottom edge of the web view: no gap under it.
 *  - WebView 140 or newer, page with viewport-fit=cover: the web view runs under the bars and
 *    the variables hold the real insets, the same inset the AdMob plugin lifts the banner by.
 *    (True because the window is edge to edge on every Android version: MainActivity sees
 *    to that on Android 14 and earlier. See "where it sits" in banner.ts.)
 * env() is only the fallback for the moment before the variables are first set.
 */
export const SAFE_AREA_BOTTOM_CSS = 'var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))';

/** The probe's height must be its content height: see ensureProbe(). */
const PROBE_BOX_SIZING = 'content-box';

/**
 * The real web view. The bottom inset is read from CSS, through a hidden probe element
 * whose padding is SAFE_AREA_BOTTOM_CSS.
 *
 * That value equals the inset the AdMob plugin anchors the banner to only because
 *  - the page declares viewport-fit=cover, and
 *  - capacitor.config.ts sets ios.contentInset 'never' (iPhone) and leaves SystemBars'
 *    insets handling on (Android),
 * which together make env() / the injected variables report the insets of the web view.
 */
export function browserViewport(): Viewport {
  let probe: HTMLElement | null = null;
  /** Watches the probe's size once onChange() has been called, for everyone who called it. */
  let observer: ResizeObserver | null = null;
  let observerListeners: Array<() => void> = [];

  const ensureProbe = (): HTMLElement | null => {
    if (probe && probe.isConnected) return probe;
    const parent = document.body || document.documentElement;
    if (!parent) return null;
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    // The inset is the bottom padding (what safeAreaBottom() reads) and also the height, so
    // that a ResizeObserver sees it change: see onChange(). A ResizeObserver watches the
    // content box, and the game's stylesheet makes every element a border box, in which a
    // height equal to the padding leaves a content box of nothing, whatever the inset is.
    // Hence box-sizing: without it the observer never fires.
    probe.style.cssText =
      `position:fixed;left:0;bottom:0;box-sizing:${PROBE_BOX_SIZING};width:0;height:${SAFE_AREA_BOTTOM_CSS};margin:0;border:0;` +
      `padding:0 0 ${SAFE_AREA_BOTTOM_CSS} 0;visibility:hidden;pointer-events:none;z-index:-1`;
    parent.appendChild(probe);
    // A probe that replaces one the game wiped away is watched like the one before it.
    try {
      observer?.observe(probe);
    } catch {
      /* the resize events still cover rotation */
    }
    return probe;
  };

  return {
    safeAreaBottom() {
      try {
        const el = ensureProbe();
        if (!el) return 0;
        const px = parseFloat(getComputedStyle(el).paddingBottom);
        return Number.isFinite(px) && px > 0 ? px : 0;
      } catch {
        return 0;
      }
    },
    width() {
      try {
        return window.innerWidth || document.documentElement.clientWidth || 0;
      } catch {
        return 0;
      }
    },
    onChange(cb) {
      try {
        window.addEventListener('resize', cb);
        window.addEventListener('orientationchange', cb);
      } catch {
        /* no window: nothing will ever change */
      }
      try {
        // The inset can change while the window keeps its size: Android sets the CSS
        // variables a moment after the page appears, and again when the player switches
        // between button and gesture navigation. Watching the probe catches those.
        if (typeof ResizeObserver !== 'function') return;
        const el = ensureProbe();
        if (!el) return;
        if (!observer) {
          const listeners: Array<() => void> = [];
          observer = new ResizeObserver(() => listeners.slice().forEach((listener) => listener()));
          observerListeners = listeners;
          observer.observe(el);
        }
        observerListeners.push(cb);
      } catch {
        /* the resize events above still cover rotation */
      }
    },
  };
}
