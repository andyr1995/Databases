// Platform abstraction.
//
// The game only ever talks to `platform`. In a browser the defaults below are
// used (no ads, no purchases, Web Share, localStorage). Inside the iOS/Android
// app, vendor/native-bridge.js swaps in real implementations (AdMob, StoreKit,
// native haptics, native share sheet, durable storage).

/**
 * @typedef {Object} AdProvider
 * @property {string} name  'none' | 'mock' | 'admob'
 * @property {() => Promise<void>} init  Settle consent and start the SDK. Never rejects.
 * @property {() => boolean} enabled  Whether this provider can ever show an ad.
 * @property {() => Promise<void>} showBanner
 * @property {() => Promise<void>} hideBanner
 * @property {(cb: (cssPx: number) => void) => void} onBannerHeight  Distance in CSS px from the bottom edge of the screen to the top edge of the banner, including any safe-area gap under it (0 when no banner is on screen).
 * @property {() => boolean} interstitialReady
 * @property {() => Promise<boolean>} showInterstitial  Resolves on dismissal; true if an ad was shown.
 * @property {() => boolean} rewardedReady
 * @property {() => Promise<boolean>} showRewarded  Resolves on dismissal; true only if the reward was earned.
 * @property {() => boolean} privacyOptionsRequired  True when a "Privacy choices" entry must be offered (GDPR regions).
 * @property {() => Promise<void>} showPrivacyOptions
 */

/**
 * @typedef {Object} IapProvider
 * @property {() => boolean} available
 * @property {() => Promise<{price: string} | null>} product  Localised price of Remove Ads, or null if the store is unreachable.
 * @property {() => Promise<boolean>} owned  Whether Remove Ads is currently owned.
 * @property {() => Promise<'purchased' | 'cancelled' | 'failed'>} purchase
 * @property {() => Promise<boolean>} restore  True if a previous purchase was found.
 */

/** @type {AdProvider} */
export const noAds = {
  name: 'none',
  init: async () => {},
  enabled: () => false,
  showBanner: async () => {},
  hideBanner: async () => {},
  onBannerHeight: () => {},
  interstitialReady: () => false,
  showInterstitial: async () => false,
  rewardedReady: () => false,
  showRewarded: async () => false,
  privacyOptionsRequired: () => false,
  showPrivacyOptions: async () => {},
};

/** @type {IapProvider} */
export const noIap = {
  available: () => false,
  product: async () => null,
  owned: async () => false,
  purchase: async () => 'failed',
  restore: async () => false,
};

const VIBRATE = { tap: 8, soft: 12, heavy: 25, success: [12, 40, 18], error: [30, 40, 30] };

export const platform = {
  isNative: false,
  /** 'web' | 'ios' | 'android' */
  os: 'web',

  /** @param {'tap'|'soft'|'heavy'|'success'|'error'} kind */
  haptic(kind) {
    try {
      if (navigator.vibrate) navigator.vibrate(VIBRATE[kind] || 8);
    } catch {
      /* not supported */
    }
  },

  /**
   * @param {{title?: string, text: string, url?: string}} payload
   * @returns {Promise<'shared'|'copied'|'cancelled'|'failed'>}
   */
  async share(payload) {
    const full = payload.url ? `${payload.text}\n${payload.url}` : payload.text;
    if (navigator.share) {
      try {
        await navigator.share({ title: payload.title, text: full });
        return 'shared';
      } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
      }
    }
    try {
      await navigator.clipboard.writeText(full);
      return 'copied';
    } catch {
      return copyWithTextarea(full) ? 'copied' : 'failed';
    }
  },

  /** Open an absolute https URL outside the game (browser tab on the web, in-app browser sheet in the app). */
  openExternal(url) {
    window.open(url, '_blank', 'noopener');
  },

  /** The first screen is drawn: the native launch screen may be dismissed. */
  appReady() {},

  /** Durable key/value storage. Strings only. get() resolves null when the key is absent. Neither call rejects. */
  persist: {
    async get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    async set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* private mode or quota: the game still works for this session */
      }
    },
  },

  /** Called with true when the app comes to the foreground, false when it leaves. */
  onActiveChange(cb) {
    document.addEventListener('visibilitychange', () => cb(document.visibilityState === 'visible'));
  },

  /** @type {AdProvider} */
  ads: noAds,
  /** @type {IapProvider} */
  iap: noIap,
};

function copyWithTextarea(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Decide which implementations to use. Call once before anything else.
 * `?ads=mock` in a browser turns on simulated ads so placements can be previewed and tested.
 */
export async function initPlatform() {
  const cap = /** @type {any} */ (window).Capacitor;
  if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
    try {
      const bridge = await import('../vendor/native-bridge.js');
      await bridge.install(platform);
    } catch (e) {
      console.error('Native bridge failed to load; continuing without adverts', e);
      // Inside the app, rewards must never be handed out for free just because
      // the advert code failed to start: report "adverts exist, none is ready".
      platform.ads = { ...noAds, name: 'unavailable', enabled: () => true };
    }
    return platform;
  }
  const params = new URLSearchParams(location.search);
  if (params.get('ads') === 'mock') {
    const { createMockAds, createMockIap } = await import('./mock-ads.js');
    platform.ads = createMockAds({ fast: params.has('fast') });
    platform.iap = createMockIap();
  }
  return platform;
}
