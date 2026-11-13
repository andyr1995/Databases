// Advert policy: WHEN adverts may appear. The provider (platform.ads) decides HOW.
//
// The rules are deliberately gentle. Players who feel ambushed delete the game;
// players who choose to watch a video for a hint keep playing for months.

export const AD_RULES = {
  /** No full-screen advert until the player has finished this many levels in total. */
  graceLevels: 8,
  /** At least this many finished levels between full-screen adverts. */
  minLevelsBetween: 3,
  /** At least this long between full-screen adverts, and after the app is opened. */
  minSecondsBetween: 110,
};

/**
 * Pure decision: is a full-screen advert allowed right now?
 * @param {{removeAds: boolean, solvedTotal: number, levelsSince: number, lastAt: number, now: number}} s
 */
export function interstitialDue(s, rules = AD_RULES) {
  if (s.removeAds) return false;
  if (s.solvedTotal < rules.graceLevels) return false;
  if (s.levelsSince < rules.minLevelsBetween) return false;
  if (s.now - s.lastAt < rules.minSecondsBetween * 1000) return false;
  return true;
}

/**
 * @param {Object} deps
 * @param {typeof import('./platform.js').platform} deps.platform
 * @param {{state: any, save: () => void}} deps.store
 * @param {typeof AD_RULES} [deps.rules]
 * @param {() => number} [deps.now]
 * @param {{onOpen?: () => void, onClose?: () => void, onBannerHeight?: (px: number) => void, onEntitlement?: (owned: boolean) => void}} [deps.hooks]
 */
export function createAdManager({ platform, store, rules = AD_RULES, now = () => Date.now(), hooks = {} }) {
  // Opening the app counts as "just saw one": nobody gets an advert in their first two minutes back.
  let lastAt = now();
  let bannerWanted = false;
  let busy = false;

  const provider = () => platform.ads;
  const adsOff = () => !!store.state.removeAds;

  function syncBanner() {
    const p = provider();
    if (bannerWanted && !adsOff() && p.enabled()) p.showBanner().catch(() => {});
    else p.hideBanner().catch(() => {});
  }

  function setEntitlement(owned) {
    if (!!store.state.removeAds === owned) return;
    store.state.removeAds = owned;
    store.save();
    syncBanner();
    if (hooks.onEntitlement) hooks.onEntitlement(owned);
  }

  async function fullscreen(show) {
    if (busy) return false;
    busy = true;
    if (hooks.onOpen) hooks.onOpen();
    try {
      return await show();
    } catch (e) {
      console.warn('Advert failed', e);
      return false;
    } finally {
      busy = false;
      if (hooks.onClose) hooks.onClose();
    }
  }

  function resetClock() {
    lastAt = now();
    store.state.ads.levelsSince = 0;
    store.save();
  }

  // Listen before anything can show a banner, so the layout always hears its height.
  provider().onBannerHeight((px) => hooks.onBannerHeight && hooks.onBannerHeight(px));

  return {
    async init() {
      const p = provider();
      try {
        await p.init();
      } catch (e) {
        console.warn('Advert provider failed to start', e);
      }
      syncBanner();
      // Confirm the purchase with the store in the background (covers reinstalls and refunds).
      if (platform.iap.available()) {
        platform.iap
          .owned()
          .then((owned) => {
            if (owned) setEntitlement(true);
          })
          .catch(() => {});
      }
    },

    /** True when the player has paid to remove adverts. */
    adsOff,

    /** Show the banner only on screens that reserve room for it. */
    setBanner(wanted) {
      bannerWanted = wanted;
      syncBanner();
    },

    /** Call once for every finished level. */
    levelCompleted() {
      store.state.ads.levelsSince = (store.state.ads.levelsSince || 0) + 1;
      store.save();
    },

    /** Show a full-screen advert if the rules allow one. Resolves when play can continue. */
    async interstitialIfDue() {
      const p = provider();
      if (!p.enabled() || !p.interstitialReady()) return false;
      const due = interstitialDue(
        {
          removeAds: adsOff(),
          solvedTotal: store.state.stats.solved,
          levelsSince: store.state.ads.levelsSince || 0,
          lastAt,
          now: now(),
        },
        rules,
      );
      if (!due) return false;
      const shown = await fullscreen(() => p.showInterstitial());
      if (shown) resetClock();
      return shown;
    },

    /**
     * How a reward can be earned right now:
     *  'free' - no advert system here (the web version): rewards are simply given.
     *  'ad'   - a rewarded video is loaded.
     *  'none' - adverts exist but none is loaded (offline, no fill).
     * @returns {'free'|'ad'|'none'}
     */
    rewardMode() {
      const p = provider();
      if (!p.enabled()) return 'free';
      return p.rewardedReady() ? 'ad' : 'none';
    },

    /** Play a rewarded video. True only if the player earned the reward. */
    async watchRewarded() {
      const p = provider();
      if (!p.enabled()) return true;
      if (!p.rewardedReady()) return false;
      const earned = await fullscreen(() => p.showRewarded());
      // Having just chosen to watch a video, the player is spared the next full-screen advert.
      resetClock();
      return earned;
    },

    removeAdsAvailable: () => platform.iap.available(),
    removeAdsPrice: async () => {
      try {
        const product = await platform.iap.product();
        return product ? product.price : null;
      } catch {
        return null;
      }
    },

    /** @returns {Promise<'purchased'|'cancelled'|'failed'>} */
    async buyRemoveAds() {
      let result = 'failed';
      try {
        result = await platform.iap.purchase();
      } catch (e) {
        console.warn('Purchase failed', e);
      }
      if (result === 'purchased') setEntitlement(true);
      return result;
    },

    /** @returns {Promise<boolean>} true if a purchase was restored */
    async restorePurchases() {
      let found = false;
      try {
        found = await platform.iap.restore();
      } catch (e) {
        console.warn('Restore failed', e);
      }
      if (found) setEntitlement(true);
      return found;
    },

    privacyOptionsRequired: () => provider().privacyOptionsRequired(),
    showPrivacyOptions: () => provider().showPrivacyOptions().catch(() => {}),
  };
}
