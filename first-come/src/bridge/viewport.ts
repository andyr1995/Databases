import type { Viewport } from './banner.ts';

/**
 * The real web view. The home-indicator inset is read from CSS, through a hidden probe
 * element whose padding is env(safe-area-inset-bottom).
 *
 * That value equals the inset the AdMob plugin anchors the banner to only because
 *  - the page declares viewport-fit=cover, and
 *  - capacitor.config.ts sets ios.contentInset 'never',
 * which together make the web view full-bleed and let env() report the real insets.
 */
export function browserViewport(): Viewport {
  let probe: HTMLElement | null = null;

  const ensureProbe = (): HTMLElement | null => {
    if (probe && probe.isConnected) return probe;
    const parent = document.body || document.documentElement;
    if (!parent) return null;
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;left:0;bottom:0;width:0;height:0;margin:0;border:0;' +
      'padding:0 0 env(safe-area-inset-bottom,0px) 0;visibility:hidden;pointer-events:none;z-index:-1';
    parent.appendChild(probe);
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
    },
  };
}
