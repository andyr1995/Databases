// Test doubles for the plugins, and a clock the tests can wind forward.
//
// The fake AdMob plugin keeps the state the Swift source of @capacitor-community/admob 8.3.0
// keeps, and answers from it (see the notes at the top of src/bridge/fullscreen.ts and
// banner.ts). That state belongs to the plugin instance, which outlives the web page:
// reloadPage() drops the listeners and the calls in flight, as Capacitor does, and keeps
// everything else.
//
//   AdInterstitialExecutor / AdRewardExecutor
//     - preparedAds, keyed by AD UNIT ID, and currentlyShowingAdId
//     - prepare*  : stores the ad under its unit id, emits Loaded, resolves; or emits
//                   FailedToLoad and rejects
//     - showInterstitial : rejects when nothing is prepared or an ad is already up; else
//                   resolves as soon as the ad is presented. Dismissal is an event.
//     - showRewardVideoAd: same rejections; resolves only when the reward is earned,
//                   otherwise stays pending
//     - Dismissed / FailedToShow delete preparedAds[the unit that was showing], which by then
//                   may hold a NEWER ad than the one that was on screen
//   BannerExecutor
//     - showBanner: resolves at once; the view is added to the screen when the ad loads
//                   (bannerArrives: SizeChanged + Loaded)
//     - hideBanner takes TWO hops to the main queue before it acts; every other banner call
//                   takes one. resumeBanner rejects when no view is on screen.
//     - removeBanner only finds a view that is on screen, and always resolves
//     - before initialize() the executors have no plugin reference: showBanner and
//                   resumeBanner never answer, removeBanner resolves without doing anything
//
// Full-screen calls act at once here (in the plugin they take one hop each, so their order
// is never in question); only the banner's hops are modelled, because there the order is.

/** Let every promise callback that is already queued run. */
export const settle = () => new Promise((resolve) => setImmediate(resolve));

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 'pending' if `promise` has not settled by the time everything already queued has run,
 * else { value } or { error }.
 */
export async function peek(promise) {
  let state = 'pending';
  promise.then(
    (value) => {
      state = { value };
    },
    (error) => {
      state = { error };
    },
  );
  await settle();
  return state;
}

export function createFakeClock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), fn, id });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    /** Delays (from now) of the timers that are waiting, soonest first. */
    delays: () => [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b),
    /** Move time forward, firing timers in order and letting promises settle after each. */
    async advance(ms) {
      const end = now + ms;
      await settle();
      for (;;) {
        const due = [...timers.values()].filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers.delete(due.id);
        now = Math.max(now, due.at);
        due.fn();
        await settle();
      }
      now = end;
      await settle();
    },
    /** Jump the wall clock without running timers, as when iOS suspends the app. */
    jump(ms) {
      now += ms;
      for (const t of timers.values()) t.at = Math.max(t.at, now);
    },
  };
}

export const EVENTS = {
  bannerSize: 'bannerAdSizeChanged',
  bannerLoaded: 'bannerAdLoaded',
  bannerFailed: 'bannerAdFailedToLoad',
  interstitialLoaded: 'interstitialAdLoaded',
  interstitialFailedToLoad: 'interstitialAdFailedToLoad',
  interstitialShowed: 'interstitialAdShowed',
  interstitialFailedToShow: 'interstitialAdFailedToShow',
  interstitialDismissed: 'interstitialAdDismissed',
  rewardedLoaded: 'onRewardedVideoAdLoaded',
  rewardedFailedToLoad: 'onRewardedVideoAdFailedToLoad',
  rewardedShowed: 'onRewardedVideoAdShowed',
  rewardedFailedToShow: 'onRewardedVideoAdFailedToShow',
  rewardedDismissed: 'onRewardedVideoAdDismissed',
  rewardedReward: 'onRewardedVideoAdReward',
};

const KIND = {
  interstitial: {
    loaded: EVENTS.interstitialLoaded,
    failedToLoad: EVENTS.interstitialFailedToLoad,
    showed: EVENTS.interstitialShowed,
    failedToShow: EVENTS.interstitialFailedToShow,
    dismissed: EVENTS.interstitialDismissed,
  },
  rewarded: {
    loaded: EVENTS.rewardedLoaded,
    failedToLoad: EVENTS.rewardedFailedToLoad,
    showed: EVENTS.rewardedShowed,
    failedToShow: EVENTS.rewardedFailedToShow,
    dismissed: EVENTS.rewardedDismissed,
  },
};

export const CONSENT_OK = {
  status: 'NOT_REQUIRED',
  isConsentFormAvailable: false,
  canRequestAds: true,
  privacyOptionsRequirementStatus: 'NOT_REQUIRED',
};

/**
 * @param {object} [options]
 * @param {object | Error | 'hang'} [options.consent]      what requestConsentInfo answers
 * @param {object | Error} [options.consentForm]           what showConsentForm answers
 * @param {string} [options.tracking]                      trackingAuthorizationStatus
 * @param {'auto' | 'manual'} [options.loads]              'auto': every prepare succeeds at once
 * @param {'present' | 'fail' | 'reject' | 'silent'} [options.showMode]
 *        present: the ad appears (Showed).  fail: present() was called but the SDK reports
 *        FailedToShow.  reject: the plugin rejects the call whatever is prepared.  silent: the
 *        plugin finds no root view controller and does nothing: no answer, no events.
 */
export function createFakeAdMob(options = {}) {
  const listeners = new Map();
  const calls = [];
  const pendingLoads = { interstitial: [], rewarded: [] };
  let rewardedShow = null;
  /** Counts the web pages this plugin instance has served; see reloadPage(). */
  let page = 1;

  const executor = () => ({ prepared: new Map(), lastPreparedAdId: null, showingAdId: null, presentations: 0, loaded: 0 });
  /** What the Swift side holds. It belongs to the plugin instance and survives reloadPage(). */
  const native = {
    /** AdMob.initialize() has run, so the executors have their plugin reference. */
    initialized: false,
    /** BannerExecutor's view: null, or { height, onScreen, hidden }. */
    banner: null,
    interstitial: executor(),
    rewarded: executor(),
  };

  // DispatchQueue.main: blocks run one at a time in the order they were queued, each later
  // than the code that queued it.
  const mainQueue = [];
  let draining = false;
  function mainAsync(block) {
    mainQueue.push(block);
    if (draining) return;
    draining = true;
    queueMicrotask(function drain() {
      const next = mainQueue.shift();
      if (!next) {
        draining = false;
        return;
      }
      try {
        next();
      } finally {
        queueMicrotask(drain);
      }
    });
  }

  /**
   * A plugin call whose `body` runs after `hops` trips through the main queue. The answer
   * only reaches the page that made the call: after a reload nobody is listening for it.
   */
  function onMain(hops, body) {
    const from = page;
    return new Promise((resolve, reject) => {
      const answer = (settleWith) => (value) => {
        if (from === page) settleWith(value);
      };
      const hop = (left) => mainAsync(() => (left > 1 ? hop(left - 1) : body(answer(resolve), answer(reject))));
      hop(hops);
    });
  }

  /** removeCurrentlyShowingAd() of both executors. */
  function removeCurrentlyShowing(kind) {
    const slot = native[kind];
    const adId = slot.showingAdId;
    if (adId === null) return;
    slot.prepared.delete(adId); // whatever is stored under that unit id NOW
    if (slot.lastPreparedAdId === adId) slot.lastPreparedAdId = [...slot.prepared.keys()].at(-1) ?? null;
    slot.showingAdId = null;
  }

  /** The guards of show*() in the executors. Returns the call's answer when nothing is presented. */
  function refusal(kind, opts) {
    const notReady = kind === 'rewarded' ? 'Reward Video is Not Ready Yet' : "Ad wasn't ready";
    if (fake.showMode === 'reject') return Promise.reject(new Error(notReady));
    const slot = native[kind];
    const adId = (opts && opts.adId) ?? slot.lastPreparedAdId;
    if (!adId) return Promise.reject(new Error('No ad prepared'));
    if (slot.showingAdId !== null) return Promise.reject(new Error('An ad is already showing'));
    if (fake.showMode === 'silent') return new Promise(() => {});
    if (!slot.prepared.has(adId)) return Promise.reject(new Error(notReady));
    slot.showingAdId = adId;
    slot.presentations++;
    return null;
  }

  const fake = {
    calls,
    /** Names of the calls made so far, without the addListener noise. */
    sequence: () => calls.map((c) => c.name).filter((n) => n !== 'addListener'),
    count: (name) => calls.filter((c) => c.name === name).length,
    last: (name) => calls.filter((c) => c.name === name).at(-1),
    consent: options.consent ?? CONSENT_OK,
    consentForm: options.consentForm ?? { status: 'OBTAINED', canRequestAds: true, privacyOptionsRequirementStatus: 'REQUIRED' },
    tracking: options.tracking ?? 'authorized',
    loads: options.loads ?? 'auto',
    showMode: options.showMode ?? 'present',
    listenersFail: false,
    initializeFails: false,
    /** The banner view vanished without a word: resumeBanner finds nothing to un-hide. */
    resumeFails: false,
    bannerHeight: 60,

    emit(event, data) {
      for (const fn of listeners.get(event) ?? []) fn(data);
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,

    // --- the native state, for assertions ------------------------------------------------
    native,
    /** A banner view is on screen and not hidden. */
    bannerOnScreen: () => !!native.banner && native.banner.onScreen && !native.banner.hidden,
    /** A full-screen ad of this kind is up. */
    adOnScreen: (kind) => native[kind].showingAdId !== null,
    /** How many ads the executor holds ready to show (0 or 1 with a single ad unit). */
    preparedCount: (kind) => native[kind].prepared.size,
    /** How many times an ad of this kind was really presented. */
    presentations: (kind) => native[kind].presentations,

    /**
     * The web view loads the page again (location.reload(), or iOS killed the web content
     * process). Capacitor forgets the listeners and the calls in flight; the plugin instance
     * and everything it holds stay.
     */
    reloadPage() {
      page++;
      listeners.clear();
      rewardedShow = null;
    },

    // --- what the tests drive ---------------------------------------------------------
    loadOk(kind) {
      const load = pendingLoads[kind].shift();
      if (!load) throw new Error(`no ${kind} load is waiting`);
      const slot = native[kind];
      slot.prepared.set(load.adId, { serial: ++slot.loaded });
      slot.lastPreparedAdId = load.adId;
      fake.emit(KIND[kind].loaded, { adUnitId: load.adId });
      if (load.page === page) load.resolve({ adUnitId: load.adId });
    },
    loadFail(kind, message = 'No fill') {
      const load = pendingLoads[kind].shift();
      if (!load) throw new Error(`no ${kind} load is waiting`);
      fake.emit(KIND[kind].failedToLoad, { code: 1, message });
      if (load.page === page) load.reject(Object.assign(new Error(message), { code: '1' }));
    },
    waitingLoads: (kind) => pendingLoads[kind].length,
    /** adDidDismissFullScreenContent */
    dismiss(kind) {
      removeCurrentlyShowing(kind);
      fake.emit(KIND[kind].dismissed);
    },
    /** didFailToPresentFullScreenContentWithError */
    failToShow(kind) {
      removeCurrentlyShowing(kind);
      fake.emit(KIND[kind].failedToShow, { code: 0, message: 'cannot present' });
    },
    /** The SDK's userDidEarnReward handler: the event, and the show promise resolving. */
    earnReward({ event = true, result = true } = {}) {
      const reward = { type: 'coins', amount: 1 };
      if (event) fake.emit(EVENTS.rewardedReward, reward);
      if (result && rewardedShow) rewardedShow.resolve(reward);
    },
    /** bannerViewDidReceiveAd (first load or a refresh): the view goes onto the screen. */
    bannerArrives(height = fake.bannerHeight) {
      if (!native.banner) throw new Error('there is no banner view that could have loaded');
      native.banner.onScreen = true;
      native.banner.height = height;
      fake.emit(EVENTS.bannerSize, { width: 390, height });
      fake.emit(EVENTS.bannerLoaded);
    },
    /** didFailToReceiveAdWithError: a view that is on screen is removed. */
    bannerFails() {
      if (native.banner && native.banner.onScreen) native.banner = null;
      fake.emit(EVENTS.bannerSize, { width: 0, height: 0 });
      fake.emit(EVENTS.bannerFailed, { code: 0, message: 'No fill' });
    },

    // --- the plugin surface -----------------------------------------------------------
    async addListener(event, fn) {
      calls.push({ name: 'addListener', event });
      if (fake.listenersFail) throw new Error('"AdMob" plugin is not implemented on ios');
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return { remove: async () => {} };
    },
    requestConsentInfo(opts) {
      calls.push({ name: 'requestConsentInfo', opts });
      if (fake.consent === 'hang') return new Promise(() => {});
      if (fake.consent instanceof Error) return Promise.reject(fake.consent);
      return Promise.resolve({ ...fake.consent });
    },
    showConsentForm() {
      calls.push({ name: 'showConsentForm' });
      if (fake.consentForm instanceof Error) return Promise.reject(fake.consentForm);
      return Promise.resolve({ ...fake.consentForm });
    },
    async showPrivacyOptionsForm() {
      calls.push({ name: 'showPrivacyOptionsForm' });
    },
    async trackingAuthorizationStatus() {
      calls.push({ name: 'trackingAuthorizationStatus' });
      return { status: fake.tracking };
    },
    async requestTrackingAuthorization() {
      calls.push({ name: 'requestTrackingAuthorization' });
      fake.tracking = 'denied';
    },
    async initialize(opts) {
      calls.push({ name: 'initialize', opts });
      if (fake.initializeFails) throw new Error('initialize failed');
      native.initialized = true;
    },

    showBanner(opts) {
      calls.push({ name: 'showBanner', opts });
      return onMain(1, (resolve) => {
        if (!native.initialized) return; // no plugin reference: the call is never answered
        // A view that is on screen is removed; one still loading is dropped with its reference.
        native.banner = { height: 0, onScreen: false, hidden: false };
        resolve();
      });
    },
    hideBanner() {
      calls.push({ name: 'hideBanner' });
      return onMain(2, (resolve) => {
        if (native.initialized) {
          if (native.banner && native.banner.onScreen) native.banner.hidden = true;
          fake.emit(EVENTS.bannerSize, { width: 0, height: 0 });
        }
        resolve();
      });
    },
    resumeBanner() {
      calls.push({ name: 'resumeBanner' });
      return onMain(1, (resolve, reject) => {
        if (!native.initialized) return;
        if (fake.resumeFails) native.banner = null;
        const view = native.banner;
        if (!view || !view.onScreen) {
          reject(new Error('AdMob: not find subView for resumeBanner'));
          return;
        }
        view.hidden = false;
        fake.emit(EVENTS.bannerSize, { width: 390, height: view.height });
        resolve();
      });
    },
    removeBanner() {
      calls.push({ name: 'removeBanner' });
      return onMain(1, (resolve) => {
        // Only a view that is on screen is found (hidden or not); one still loading stays.
        if (native.initialized && native.banner && native.banner.onScreen) native.banner = null;
        resolve();
      });
    },

    prepareInterstitial: (opts) => prepare('interstitial', 'prepareInterstitial', opts),
    prepareRewardVideoAd: (opts) => prepare('rewarded', 'prepareRewardVideoAd', opts),

    showInterstitial(opts) {
      calls.push({ name: 'showInterstitial', opts });
      const refused = refusal('interstitial', opts);
      if (refused) return refused;
      // The plugin resolves right after calling present(); how that went arrives as an event.
      if (fake.showMode === 'fail') fake.failToShow('interstitial');
      else fake.emit(EVENTS.interstitialShowed);
      return Promise.resolve();
    },
    showRewardVideoAd(opts) {
      calls.push({ name: 'showRewardVideoAd', opts });
      const refused = refusal('rewarded', opts);
      if (refused) return refused;
      const shown = deferred();
      rewardedShow = shown;
      if (fake.showMode === 'fail') fake.failToShow('rewarded');
      else fake.emit(EVENTS.rewardedShowed);
      return shown.promise; // pending until the reward is earned, like the plugin
    },
  };

  function prepare(kind, name, opts) {
    calls.push({ name, opts });
    const load = { ...deferred(), adId: opts.adId, page };
    pendingLoads[kind].push(load);
    if (fake.loads === 'auto') fake.loadOk(kind);
    return load.promise;
  }

  return fake;
}

/** platform.persist stand-in: an in-memory map that never rejects. */
export function createMemoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (key) => (data.has(key) ? data.get(key) : null),
    set: async (key, value) => {
      data.set(key, value);
    },
  };
}

/** The app-state hub the provider subscribes to. `fire(true)` = the app came to the foreground. */
export function createFakeAppState() {
  const subscribers = [];
  return {
    onActive: (cb) => subscribers.push(cb),
    fire: (active) => subscribers.forEach((cb) => cb(active)),
  };
}

export function createFakeViewport({ safeAreaBottom = 34, width = 390 } = {}) {
  const watchers = [];
  const viewport = {
    inset: safeAreaBottom,
    w: width,
    safeAreaBottom: () => viewport.inset,
    width: () => viewport.w,
    onChange: (cb) => watchers.push(cb),
    change(next) {
      Object.assign(viewport, next);
      watchers.forEach((cb) => cb());
    },
  };
  return viewport;
}

export const UNITS = {
  banner: 'ca-app-pub-3940256099942544/2435281174',
  interstitial: 'ca-app-pub-3940256099942544/4411468910',
  rewarded: 'ca-app-pub-3940256099942544/1712485313',
};

export const quiet = () => {};
