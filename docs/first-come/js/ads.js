// Advert policy: WHEN adverts may appear. The provider (platform.ads) decides HOW.
//
// The rules are deliberately gentle. Players who feel ambushed delete the game;
// players who choose to watch a video for a hint keep playing for months.

export const AD_RULES = {
  /** No full-screen advert until the player has finished this many levels in total. */
  graceLevels: 12,
  /** At least this many finished levels between full-screen adverts. */
  minLevelsBetween: 3,
  /** At least this long between full-screen adverts, and after the app is opened or brought back. */
  minSecondsBetween: 110,
  /**
   * A full-screen advert is announced for this long before it appears, so it never
   * lands under a finger that has just tapped "Next level" (milliseconds).
   */
  noticeMs: 700,
  /**
   * If an advert call has not come back after this long, the player is offered a way
   * out. Longer than the 10 seconds the native bridge allows an advert to appear.
   */
  patienceMs: 12000,
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
 * @param {{onOpen?: (info: {kind: 'interstitial'|'rewarded', patienceMs: number, cancel: () => void}) => void, onClose?: () => void, onBannerHeight?: (px: number) => void, onBannerWanted?: (wanted: boolean) => void, onEntitlement?: (owned: boolean) => void}} [deps.hooks]
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
    const show = bannerWanted && !adsOff() && p.enabled();
    // Tell the layout first, so it can keep a strip free before the banner has loaded
    // (otherwise the board would jump when the advert arrives a moment into a level).
    if (hooks.onBannerWanted) hooks.onBannerWanted(show);
    if (show) p.showBanner().catch(() => {});
    else p.hideBanner().catch(() => {});
  }

  function setEntitlement(owned) {
    if (!!store.state.removeAds === owned) return;
    store.state.removeAds = owned;
    store.save();
    syncBanner();
    if (hooks.onEntitlement) hooks.onEntitlement(owned);
  }

  /**
   * Run one full-screen advert. Between onOpen and onClose the app covers the screen, so
   * the player cannot wander off while an advert is on its way (which would lose a reward
   * they then earn, or drop an advert onto the wrong screen).
   *
   * The provider is not trusted to answer: `cancel`, handed to onOpen, settles the call as
   * "nothing shown" and frees the game; an answer that arrives after that is ignored.
   * @param {'interstitial'|'rewarded'} kind
   * @param {() => Promise<boolean>} show
   * @returns {Promise<boolean>}
   */
  function fullscreen(kind, show) {
    if (busy) return Promise.resolve(false);
    busy = true;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        busy = false;
        if (hooks.onClose) hooks.onClose();
        resolve(result);
      };
      if (hooks.onOpen) hooks.onOpen({ kind, patienceMs: rules.patienceMs, cancel: () => finish(false) });
      const start = () => {
        if (settled) return;
        Promise.resolve()
          .then(show)
          .then(
            (result) => finish(!!result),
            (e) => {
              console.warn('Advert failed', e);
              finish(false);
            },
          );
      };
      if (kind === 'interstitial' && rules.noticeMs > 0) setTimeout(start, rules.noticeMs);
      else start();
    });
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
      this.checkEntitlement();
    },

    /**
     * Ask the store, in the background, whether Remove Ads is owned. Covers a reinstall, a new
     * phone, and a purchase that was approved later (Ask to Buy). Only a definite yes is acted
     * on: "no" cannot be told apart from "could not reach the store", so a purchase is never
     * taken away here.
     */
    checkEntitlement() {
      if (adsOff() || !platform.iap.available()) return;
      platform.iap
        .owned()
        .then((owned) => {
          if (owned) setEntitlement(true);
        })
        .catch(() => {});
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
      // The time rule restarts the moment an advert is asked for, whatever the provider then
      // reports, so a provider that wrongly says "not shown" can never cause one after every level.
      lastAt = now();
      const shown = await fullscreen('interstitial', () => p.showInterstitial());
      if (shown) resetClock();
      return shown;
    },

    /** The app has come back after being away for a while: treat it like a fresh start. */
    resumed() {
      lastAt = now();
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
      const earned = await fullscreen('rewarded', () => p.showRewarded());
      // Having just watched a video by choice, the player is spared the next full-screen advert.
      if (earned) resetClock();
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
