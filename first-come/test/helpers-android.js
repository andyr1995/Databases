// Test doubles for the Android side of the plugins. Like the fakes in helpers.js they keep
// the state the native code keeps and answer from it; here the native code is the Java and
// Kotlin source of
//   @capacitor-community/admob 8.3.0   android/src/main/java/com/getcapacitor/community/admob
//   @capacitor/app 8.1.2               AppPlugin.java, and BridgeActivity.java of @capacitor/android 8.6.2
//   @capgo/native-purchases 8.9.16     NativePurchasesPlugin.java (Play Billing Library 9.1.0)
//
// Threads. Capacitor runs every plugin method on one background thread, in the order the
// page made the calls. Anything that touches views is handed on to the UI thread with
// runOnUiThread, also in order. The fake AdMob plugin models that with two queues: the
// plugin thread runs on promise callbacks, the UI thread on setImmediate. So an answer
// given from the plugin thread reaches the page, and the page's next call is carried out,
// BEFORE the UI work queued earlier has happened. On a phone that is a race the UI thread
// usually wins; here it always loses, which is the case the bridge has to survive.
// `await settle()` (and every step of the fake clock) lets the UI thread work off what it
// has been handed so far; `await flush()` also what that sets off.

import { CONSENT_OK, EVENTS, settle } from './helpers.js';

/**
 * Let the fake's UI thread catch up, also with work that earlier UI work set off (a call's
 * answer leads the caller to make the next call, which goes to the UI thread in its turn).
 */
export async function flush() {
  for (let i = 0; i < 4; i++) await settle();
}

const KIND = {
  interstitial: {
    loaded: EVENTS.interstitialLoaded,
    failedToLoad: EVENTS.interstitialFailedToLoad,
    showed: EVENTS.interstitialShowed,
    failedToShow: EVENTS.interstitialFailedToShow,
    dismissed: EVENTS.interstitialDismissed,
    notPrepared: 'No Interstitial can be shown. It was not prepared or maybe it failed to be prepared.',
  },
  rewarded: {
    loaded: EVENTS.rewardedLoaded,
    failedToLoad: EVENTS.rewardedFailedToLoad,
    showed: EVENTS.rewardedShowed,
    failedToShow: EVENTS.rewardedFailedToShow,
    dismissed: EVENTS.rewardedDismissed,
    notPrepared: 'No Reward Video Ad can be shown. It was not prepared or maybe it failed to be prepared.',
  },
};

/** What PluginCall.reject(message, code) becomes in the page. */
export const rejection = (message, code) => Object.assign(new Error(message), code === undefined ? {} : { code });

/**
 * The AdMob plugin as its Android source behaves.
 *
 * @param {object} [options]
 * @param {object | Error | 'hang'} [options.consent]
 * @param {object | Error} [options.consentForm]
 * @param {'auto' | 'manual'} [options.loads]
 * @param {'present' | 'fail' | 'silent'} [options.showMode]
 *        present: the ad activity comes up (Showed).  fail: the SDK refuses to present
 *        (FailedToShow).  silent: show() is called and nothing ever comes of it.
 */
export function createFakeAndroidAdMob(options = {}) {
  const listeners = new Map();
  const calls = [];
  const pendingLoads = { interstitial: [], rewarded: [] };
  let page = 1;

  const executor = () => ({ prepared: new Map(), lastPreparedAdId: null, showing: null, presentations: 0, loaded: 0 });
  /** What the Java side holds. It outlives the page; the two prepared-ad maps are even static. */
  const native = {
    initialized: false,
    /** BannerExecutor.mAdView: null, or { size, loaded, paused }. */
    adView: null,
    /** BannerExecutor.mAdViewLayout: null until the first banner, then { attached, visible }. Never set back to null. */
    layout: null,
    interstitial: executor(),
    rewarded: executor(),
    /** An uncaught exception on the UI thread ends the app. The bridge must never cause one. */
    crashed: null,
  };

  // --- the two threads -------------------------------------------------------------------
  // Each runs its tasks in the order they were queued. The plugin thread gets going on the
  // next promise callback; the UI thread only on the next setImmediate, where it works off
  // everything that has been handed to it by then.
  const queue = (schedule) => {
    const tasks = [];
    let scheduled = false;
    const drain = () => {
      scheduled = false;
      while (tasks.length) tasks.shift()();
    };
    return (task) => {
      tasks.push(task);
      if (!scheduled) {
        scheduled = true;
        schedule(drain);
      }
    };
  };
  const onPluginThread = queue(queueMicrotask);
  const runOnUiThread = queue(setImmediate);

  /** A plugin call: `body` runs on the plugin thread; the answer only reaches the page that asked. */
  function pluginCall(name, opts, body) {
    calls.push(opts === undefined ? { name } : { name, opts });
    const from = page;
    return new Promise((resolve, reject) => {
      const answer = (settleWith) => (value) => {
        if (from === page) settleWith(value);
      };
      onPluginThread(() => body(answer(resolve), answer(reject)));
    });
  }

  const emit = (event, data) => {
    for (const fn of listeners.get(event) ?? []) fn(data);
  };

  // --- full-screen ads ---------------------------------------------------------------------

  /** The onCompleted that show*() attaches to the ad: forget what is filed under that ad unit id NOW. */
  function forget(kind, adId) {
    const slot = native[kind];
    slot.prepared.delete(adId);
    if (slot.lastPreparedAdId === adId) slot.lastPreparedAdId = [...slot.prepared.keys()].at(-1) ?? null;
  }

  /** The ad on screen closed, or failed to open after all. */
  function completed(kind) {
    const slot = native[kind];
    if (!slot.showing) return;
    forget(kind, slot.showing.adId);
    slot.showing = null;
  }

  function prepare(kind, name, opts) {
    return pluginCall(name, opts, (resolve, reject) => {
      runOnUiThread(() => {
        pendingLoads[kind].push({ adId: opts.adId, resolve, reject });
        if (fake.loads === 'auto') fake.loadOk(kind);
      });
    });
  }

  function show(kind, name, opts) {
    return pluginCall(name, opts, (resolve, reject) => {
      const slot = native[kind];
      const adId = (opts && opts.adId) ?? slot.lastPreparedAdId;
      const ad = adId ? slot.prepared.get(adId) : undefined;
      if (!ad) {
        reject(rejection(KIND[kind].notPrepared));
        emit(KIND[kind].failedToLoad, { code: -1, message: KIND[kind].notPrepared }); // sic: FailedToLoad
        return;
      }
      runOnUiThread(() => {
        // There is no "already showing" guard in the plugin. The SDK refuses an ad object
        // that has been shown before, through the callback that was just attached.
        const refused = ad.used || fake.showMode === 'fail';
        ad.used = true;
        if (kind === 'interstitial') resolve(); // right after InterstitialAd.show() was called
        else ad.rewardCall = resolve; // only OnUserEarnedRewardListener resolves this one
        if (fake.showMode === 'silent') return;
        if (refused) {
          forget(kind, adId);
          emit(KIND[kind].failedToShow, { code: 0, message: 'The ad can not be shown.' });
          return;
        }
        slot.showing = { adId, ad };
        slot.presentations++;
        setImmediate(() => emit(KIND[kind].showed, {})); // onAdShowedFullScreenContent, once the ad activity is up
      });
    });
  }

  // --- banner ------------------------------------------------------------------------------

  const fake = {
    calls,
    sequence: () => calls.map((c) => c.name).filter((n) => n !== 'addListener'),
    count: (name) => calls.filter((c) => c.name === name).length,
    last: (name) => calls.filter((c) => c.name === name).at(-1),
    consent: options.consent ?? CONSENT_OK,
    consentForm: options.consentForm ?? { status: 'OBTAINED', canRequestAds: true, privacyOptionsRequirementStatus: 'REQUIRED' },
    loads: options.loads ?? 'auto',
    showMode: options.showMode ?? 'present',
    listenersFail: false,
    /** android.R.id.content never gets its child: initialize() rejects after its 5 s wait. */
    bannerParentMissing: false,
    /** AdSize.getHeight() of the adaptive banner, in dp. Fixed when the AdView is created. */
    bannerHeight: 60,

    emit,
    listenerCount: (event) => (listeners.get(event) ?? []).length,

    native,
    /** A loaded banner is attached and visible. */
    bannerOnScreen: () => !!native.adView && native.adView.loaded && !!native.layout && native.layout.attached && native.layout.visible,
    adOnScreen: (kind) => native[kind].showing !== null,
    preparedCount: (kind) => native[kind].prepared.size,
    presentations: (kind) => native[kind].presentations,

    /** location.reload(): Bridge.reset() drops the listeners; calls in flight answer nobody. */
    reloadPage() {
      page++;
      listeners.clear();
    },

    // --- what the tests drive ---------------------------------------------------------
    loadOk(kind) {
      const load = pendingLoads[kind].shift();
      if (!load) throw new Error(`no ${kind} load is waiting`);
      const slot = native[kind];
      slot.prepared.set(load.adId, { serial: ++slot.loaded, used: false, rewardCall: null });
      slot.lastPreparedAdId = load.adId;
      load.resolve({ adUnitId: load.adId }); // the call is answered first,
      setImmediate(() => emit(KIND[kind].loaded, { adUnitId: load.adId })); // and the event reaches the page after the answer
    },
    loadFail(kind, message = 'No fill') {
      const load = pendingLoads[kind].shift();
      if (!load) throw new Error(`no ${kind} load is waiting`);
      emit(KIND[kind].failedToLoad, { code: 3, message });
      load.reject(rejection(message, '3'));
    },
    waitingLoads: (kind) => pendingLoads[kind].length,
    /** onAdDismissedFullScreenContent */
    dismiss(kind) {
      completed(kind);
      emit(KIND[kind].dismissed, {});
    },
    /** onAdFailedToShowFullScreenContent */
    failToShow(kind) {
      completed(kind);
      emit(KIND[kind].failedToShow, { code: 0, message: 'cannot present' });
    },
    /**
     * Android destroys the ad activity without the SDK reporting anything (the player went
     * Home and came back through the launcher icon: the game's activity is singleTask).
     */
    adActivityDestroyed(kind) {
      native[kind].showing = null; // the plugin's callback never ran: preparedAds keeps the used ad
    },
    /** OnUserEarnedRewardListener: the event first, then the show call resolves. */
    earnReward({ event = true, result = true } = {}) {
      const reward = { type: 'coins', amount: 1 };
      if (event) emit(EVENTS.rewardedReward, reward);
      const showing = native.rewarded.showing;
      if (result && showing && showing.ad.rewardCall) showing.ad.rewardCall(reward);
    },
    /** AdListener.onAdLoaded of the current AdView (first load or a refresh). */
    bannerArrives(height) {
      const view = native.adView;
      if (!view) throw new Error('there is no AdView that could have loaded');
      if (height !== undefined) view.size.height = height;
      view.loaded = true;
      emit(EVENTS.bannerSize, { ...view.size });
      emit(EVENTS.bannerLoaded, {});
    },
    /** AdListener.onAdFailedToLoad of the current AdView: the view is removed and forgotten. */
    bannerFails() {
      if (!native.adView) throw new Error('there is no AdView that could have failed');
      native.layout.attached = false;
      native.adView = null;
      emit(EVENTS.bannerSize, { width: 0, height: 0 });
      emit(EVENTS.bannerFailed, { code: 3, message: 'No fill' });
    },

    // --- the plugin surface -----------------------------------------------------------
    async addListener(event, fn) {
      calls.push({ name: 'addListener', event });
      if (fake.listenersFail) throw new Error('"AdMob" plugin is not implemented on android');
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return { remove: async () => {} };
    },
    requestConsentInfo(opts) {
      return pluginCall('requestConsentInfo', opts, (resolve, reject) => {
        if (fake.consent === 'hang') return;
        if (fake.consent instanceof Error) reject(fake.consent);
        else resolve({ ...fake.consent });
      });
    },
    showConsentForm() {
      return pluginCall('showConsentForm', undefined, (resolve, reject) => {
        runOnUiThread(() => {
          if (fake.consentForm instanceof Error) reject(fake.consentForm);
          else resolve({ ...fake.consentForm });
        });
      });
    },
    showPrivacyOptionsForm() {
      return pluginCall('showPrivacyOptionsForm', undefined, (resolve) => runOnUiThread(() => resolve()));
    },
    trackingAuthorizationStatus() {
      // AdMob.java: always AuthorizationStatusEnum.AUTHORIZED
      return pluginCall('trackingAuthorizationStatus', undefined, (resolve) => resolve({ status: 'authorized' }));
    },
    requestTrackingAuthorization() {
      return pluginCall('requestTrackingAuthorization', undefined, (resolve) => resolve());
    },
    initialize(opts) {
      return pluginCall('initialize', opts, (resolve, reject) => {
        runOnUiThread(() => {
          native.initialized = true; // MobileAds.initialize()
          if (fake.bannerParentMissing) reject(rejection('AdMob initialized, but the banner parent view never appeared'));
          else resolve();
        });
      });
    },

    showBanner(opts) {
      return pluginCall('showBanner', opts, (resolve) => {
        if (native.adView !== null) {
          // updateExistingAdView(): reloads the view the plugin already holds. The layout
          // keeps its visibility, and the call is NEVER answered.
          const existing = native.adView;
          runOnUiThread(() => {
            if (existing === native.adView) existing.reloads++;
          });
          return;
        }
        const view = { size: { width: 390, height: fake.bannerHeight }, loaded: false, paused: false, reloads: 0 };
        native.adView = view;
        native.layout = { attached: false, visible: true };
        const layout = native.layout;
        runOnUiThread(() => {
          if (view !== native.adView) return; // removed before this ran
          layout.attached = true; // added to the web view's parent at once; nothing to see until the ad loads
        });
        resolve();
      });
    },
    hideBanner() {
      return pluginCall('hideBanner', undefined, (resolve, reject) => {
        if (native.adView === null) {
          reject(rejection('You tried to hide a banner that was never shown'));
          return;
        }
        runOnUiThread(() => {
          if (native.layout === null) return;
          native.layout.visible = false;
          if (native.adView === null) {
            // mAdView.pause() on a view that a failed load or a removal has set to null meanwhile
            native.crashed = 'NullPointerException in hideBanner';
            return;
          }
          native.adView.paused = true;
          emit(EVENTS.bannerSize, { width: 0, height: 0 });
          resolve();
        });
      });
    },
    resumeBanner() {
      return pluginCall('resumeBanner', undefined, (resolve) => {
        runOnUiThread(() => {
          if (native.layout === null || native.adView === null) return;
          native.layout.visible = true;
          native.adView.paused = false;
          emit(EVENTS.bannerSize, { ...native.adView.size });
        });
        resolve(); // before the UI thread has done anything, and also when there is no view
      });
    },
    removeBanner() {
      return pluginCall('removeBanner', undefined, (resolve) => {
        if (native.adView !== null) {
          runOnUiThread(() => {
            if (native.adView === null) return;
            native.layout.attached = false;
            native.adView = null;
            emit(EVENTS.bannerSize, { width: 0, height: 0 });
          });
        }
        resolve(); // before the view is gone
      });
    },

    prepareInterstitial: (opts) => prepare('interstitial', 'prepareInterstitial', opts),
    prepareRewardVideoAd: (opts) => prepare('rewarded', 'prepareRewardVideoAd', opts),
    showInterstitial: (opts) => show('interstitial', 'showInterstitial', opts),
    showRewardVideoAd: (opts) => show('rewarded', 'showRewardVideoAd', opts),
  };

  return fake;
}

/**
 * The App plugin on Android, with the activity it watches.
 *
 * BridgeActivity: onResume -> isActive true (every time), onStop -> isActive false.
 * AppPlugin: 'pause' on onPause, 'resume' on onResume once the activity has ever been paused.
 * Back: the plugin's OnBackPressedCallback swallows the press. Without a 'backButton'
 * listener it steps the web view back if there is history, else does nothing; with one it
 * only sends the event.
 */
export function createFakeAndroidApp() {
  const listeners = new Map();
  let hasPausedEver = false;
  const notify = (event, data) => {
    for (const fn of listeners.get(event) ?? []) fn(data);
  };
  const app = {
    calls: [],
    listenersFail: false,
    /** Activity.moveTaskToBack(true) calls so far. */
    minimized: 0,
    /** WebView.goBack() calls so far (the plugin's default when the page does not listen). */
    wentBackInHistory: 0,
    canGoBack: false,
    listenerCount: (event) => (listeners.get(event) ?? []).length,

    async addListener(event, fn) {
      app.calls.push({ name: 'addListener', event });
      if (app.listenersFail) throw new Error('"App" plugin is not implemented on android');
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return { remove: async () => {} };
    },
    async minimizeApp() {
      app.calls.push({ name: 'minimizeApp' });
      app.minimized++;
    },

    /** Something lies on top of the game (an ad, the purchase sheet): Activity.onPause. */
    paused() {
      hasPausedEver = true;
      notify('pause');
    },
    /** The game is completely covered or in the background: Activity.onStop. */
    stopped() {
      notify('appStateChange', { isActive: false });
    },
    /** Nothing lies on top of the game any more: Activity.onResume. */
    resumed() {
      notify('appStateChange', { isActive: true });
      if (hasPausedEver) notify('resume');
    },
    /** The Back button or gesture. */
    pressBack() {
      if (app.listenerCount('backButton') === 0) {
        if (app.canGoBack) app.wentBackInHistory++;
        return;
      }
      notify('backButton', { canGoBack: app.canGoBack });
    },
    /** Bridge.reset() on a page load. */
    reloadPage() {
      listeners.clear();
    },
  };
  return app;
}

const PURCHASED = 1;
const PENDING = 2;

/**
 * @capgo/native-purchases on Android, with the Google Play account behind it.
 *
 * `play.purchases` is what Play has on record for the signed-in account: entries
 * { token, productId, state (1 paid, 2 pending), acknowledged }.
 *
 * Connections. Every plugin call that needs Google Play goes through withBillingClient(),
 * which first runs initBillingClient(): closeBillingClientLocked() ENDS the connection the
 * call before it opened, unless that one has a purchase sheet open or an acknowledgement in
 * flight. A lookup (getProduct, getPurchases) has neither, and BillingClient.endConnection()
 * drops the work queued on it: a lookup that has not answered by the time the next call of
 * any kind arrives never answers at all. The fake keeps to that: a lookup answers one step
 * after it was made (or, with `holdLookups`, when `answerLookups()` is called), and a call
 * that arrives before then cuts it off for good (`play.lookupsCutOff` counts them).
 *
 * @param {object} [options]
 * @param {'buy' | 'cancel' | 'pending' | 'error'} [options.sheet]  what the player does with Play's purchase sheet
 * @param {boolean} [options.holdLookups]  lookups stay unanswered until answerLookups() is called
 */
export function createFakePlayPurchases(options = {}) {
  const calls = [];
  let nextToken = 1;
  const play = {
    catalog: new Map([['remove_ads', { title: 'Remove Ads', price: 2.99, priceString: '£2.99', currencyCode: 'GBP' }]]),
    purchases: [],
    /** Google Play cannot be reached at all (no Play Store, or its service is down). */
    unavailable: false,
    /** Play answers every acknowledgement with an error (the connection has just dropped). */
    acknowledgeFails: false,
    acknowledgeAttempts: 0,
    /** Lookups whose connection a later call ended before they had answered. They never answer. */
    lookupsCutOff: 0,
  };

  /** The lookup whose connection to Play is open and unanswered, if any. */
  let openLookup = null;
  /** Answers of held lookups, in the order the lookups were made. */
  const held = [];

  /** initBillingClient(): the call that arrives ends the connection of an unanswered lookup. */
  const connect = () => {
    if (openLookup) {
      openLookup.cutOff = true;
      openLookup = null;
      play.lookupsCutOff++;
    }
  };

  /** A lookup on a connection of its own: `answer` is what Play says once it gets to answer. */
  const lookup = (answer) =>
    new Promise((resolve, reject) => {
      connect();
      const mine = { cutOff: false };
      openLookup = mine;
      const answerNow = () => {
        if (mine.cutOff) return; // endConnection() dropped it: the page never hears of it again
        if (openLookup === mine) openLookup = null;
        try {
          resolve(answer());
        } catch (error) {
          reject(error);
        }
      };
      if (fake.holdLookups) held.push(answerNow);
      else Promise.resolve().then(answerNow);
    });

  const entry = (p, productType = 'inapp') => ({
    transactionId: p.token,
    productIdentifier: p.productId,
    purchaseDate: '2026-11-14T10:00:00Z',
    quantity: 1,
    productType,
    orderId: p.state === PURCHASED ? `GPA.0000-${p.token}` : undefined,
    purchaseToken: p.token,
    isAcknowledged: p.acknowledged,
    purchaseState: String(p.state),
    willCancel: null,
  });

  /** initBillingClient(): what a call gets when the connection to Play cannot be made. */
  const setupFailure = () => rejection('BILLING_SETUP_FAILED', 'Billing is not available on this device.'); // sic: the plugin passes code and message the wrong way round

  const acknowledgeOnPlay = (p) => {
    play.acknowledgeAttempts++;
    if (play.acknowledgeFails) return false;
    p.acknowledged = true;
    return true;
  };

  const fake = {
    calls,
    count: (name) => calls.filter((c) => c.name === name).length,
    play,
    sheet: options.sheet ?? 'buy',
    holdLookups: options.holdLookups === true,
    /** How many lookups are waiting for answerLookups(). */
    heldLookups: () => held.length,
    /** Google Play answers the lookups that were held back (those not cut off meanwhile). */
    answerLookups() {
      for (const answerNow of held.splice(0)) answerNow();
    },

    /** A pending payment goes through (the cash was paid, the parent agreed). No purchase call is under way. */
    paymentCleared(token) {
      const p = play.purchases.find((x) => x.token === token);
      if (!p) throw new Error(`no purchase ${token}`);
      p.state = PURCHASED;
    },
    /** Play hands the money back, as it does for a purchase left unacknowledged for three days. */
    refunded(token) {
      play.purchases = play.purchases.filter((x) => x.token !== token);
    },
    /** A purchase the account made elsewhere (another phone, a promo code in the Play Store). */
    ownedElsewhere(productId, { acknowledged = true } = {}) {
      const p = { token: `token-${nextToken++}`, productId, state: PURCHASED, acknowledged };
      play.purchases.push(p);
      return p;
    },

    async getProduct(opts) {
      calls.push({ name: 'getProduct', opts });
      if (!opts.productIdentifier) throw rejection('productIdentifier is empty');
      return lookup(() => {
        if (play.unavailable) throw setupFailure();
        const item = play.catalog.get(opts.productIdentifier);
        if (!item || (opts.productType ?? 'inapp') !== 'inapp') throw rejection('Product not found');
        return { product: { identifier: opts.productIdentifier, description: '', isFamilyShareable: false, ...item } };
      });
    },

    async getPurchases(opts = {}) {
      calls.push({ name: 'getPurchases', opts });
      if (opts.productType !== undefined && opts.productType !== 'inapp' && opts.productType !== 'subs') return { purchases: [] };
      return lookup(() => {
        if (play.unavailable) throw setupFailure();
        // The one product is a one-time product, so a 'subs' query finds nothing.
        return { purchases: opts.productType === 'subs' ? [] : play.purchases.map((p) => entry(p)) };
      });
    },

    async purchaseProduct(opts) {
      calls.push({ name: 'purchaseProduct', opts });
      if (!opts.productIdentifier) throw rejection('productIdentifier is empty');
      if ((opts.quantity ?? 1) < 1) throw rejection('quantity is less than 1');
      connect();
      if (play.unavailable) throw setupFailure();
      const productType = opts.productType ?? 'inapp';
      if (!play.catalog.has(opts.productIdentifier) || productType !== 'inapp') throw rejection('Product not found');
      if (play.purchases.some((p) => p.productId === opts.productIdentifier)) {
        throw rejection('Purchase is not purchased', 'ITEM_ALREADY_OWNED');
      }
      if (fake.sheet === 'cancel') throw rejection('Purchase is not purchased', 'USER_CANCELED');
      if (fake.sheet === 'error') throw rejection('Purchase is not purchased', 'SERVICE_UNAVAILABLE');
      const p = { token: `token-${nextToken++}`, productId: opts.productIdentifier, state: PURCHASED, acknowledged: false };
      play.purchases.push(p);
      if (fake.sheet === 'pending') {
        p.state = PENDING;
        throw rejection('Purchase is pending');
      }
      // handlePurchase(): PurchaseActionDecider says CONSUME for a consumable, else ACKNOWLEDGE.
      if (opts.isConsumable === true) play.purchases = play.purchases.filter((x) => x !== p);
      else if (opts.autoAcknowledgePurchases !== false) acknowledgeOnPlay(p);
      // The call resolves whether or not the acknowledgement went through.
      return entry(p, productType);
    },

    async restorePurchases() {
      calls.push({ name: 'restorePurchases' });
      connect();
      if (play.unavailable) throw setupFailure();
      // processUnfinishedPurchases(): acknowledge what is paid for and not acknowledged.
      for (const p of play.purchases) if (p.state === PURCHASED && !p.acknowledged) acknowledgeOnPlay(p);
    },

    async acknowledgePurchase(opts) {
      calls.push({ name: 'acknowledgePurchase', opts });
      if (!opts || !opts.purchaseToken) throw rejection('purchaseToken is required');
      connect();
      if (play.unavailable) throw setupFailure();
      const p = play.purchases.find((x) => x.token === opts.purchaseToken);
      if (!p || p.state !== PURCHASED || p.acknowledged || !acknowledgeOnPlay(p)) {
        throw rejection('Failed to acknowledge purchase: ');
      }
    },
  };
  return fake;
}
