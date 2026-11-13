// Test doubles for the plugins, and a clock the tests can wind forward.
//
// The fake AdMob plugin behaves the way the Swift source of @capacitor-community/admob 8.3.0
// does (see the notes at the top of src/bridge/fullscreen.ts and banner.ts):
//   - prepare*  : emits Loaded then resolves, or emits FailedToLoad then rejects
//   - showInterstitial : resolves as soon as the ad is presented; dismissal is an event
//   - showRewardVideoAd: resolves only when the reward is earned, otherwise stays pending
//   - showBanner: resolves at once; the banner arrives later as SizeChanged + Loaded events

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

/** Resolves 'pending' if `promise` has not settled yet, else { value } or { error }. */
export async function peek(promise) {
  const pending = Symbol('pending');
  await settle();
  const result = await Promise.race([
    promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    Promise.resolve(pending),
  ]);
  return result === pending ? 'pending' : result;
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
 *        FailedToShow.  reject: the plugin rejects the call.  silent: no answer, no events.
 */
export function createFakeAdMob(options = {}) {
  const listeners = new Map();
  const calls = [];
  const pendingLoads = { interstitial: [], rewarded: [] };
  let rewardedShow = null;

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
    resumeFails: false,
    bannerHeight: 60,

    emit(event, data) {
      for (const fn of listeners.get(event) ?? []) fn(data);
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,

    // --- what the tests drive ---------------------------------------------------------
    loadOk(kind) {
      const load = pendingLoads[kind].shift();
      if (!load) throw new Error(`no ${kind} load is waiting`);
      fake.emit(KIND[kind].loaded, { adUnitId: load.adId });
      load.resolve({ adUnitId: load.adId });
    },
    loadFail(kind, message = 'No fill') {
      const load = pendingLoads[kind].shift();
      if (!load) throw new Error(`no ${kind} load is waiting`);
      fake.emit(KIND[kind].failedToLoad, { code: 1, message });
      load.reject(Object.assign(new Error(message), { code: '1' }));
    },
    waitingLoads: (kind) => pendingLoads[kind].length,
    dismiss: (kind) => fake.emit(KIND[kind].dismissed),
    failToShow: (kind) => fake.emit(KIND[kind].failedToShow, { code: 0, message: 'cannot present' }),
    /** The SDK's userDidEarnReward handler: the event, and the show promise resolving. */
    earnReward({ event = true, result = true } = {}) {
      const reward = { type: 'coins', amount: 1 };
      if (event) fake.emit(EVENTS.rewardedReward, reward);
      if (result && rewardedShow) rewardedShow.resolve(reward);
    },
    bannerArrives(height = fake.bannerHeight) {
      fake.emit(EVENTS.bannerSize, { width: 390, height });
      fake.emit(EVENTS.bannerLoaded);
    },
    bannerFails() {
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
    },

    async showBanner(opts) {
      calls.push({ name: 'showBanner', opts });
    },
    async hideBanner() {
      calls.push({ name: 'hideBanner' });
      fake.emit(EVENTS.bannerSize, { width: 0, height: 0 });
    },
    async resumeBanner() {
      calls.push({ name: 'resumeBanner' });
      if (fake.resumeFails) throw new Error('AdMob: not find subView for resumeBanner');
      fake.emit(EVENTS.bannerSize, { width: 390, height: fake.bannerHeight });
    },
    async removeBanner() {
      calls.push({ name: 'removeBanner' });
    },

    prepareInterstitial: (opts) => prepare('interstitial', 'prepareInterstitial', opts),
    prepareRewardVideoAd: (opts) => prepare('rewarded', 'prepareRewardVideoAd', opts),

    showInterstitial(opts) {
      calls.push({ name: 'showInterstitial', opts });
      if (fake.showMode === 'reject') return Promise.reject(new Error("Ad wasn't ready"));
      if (fake.showMode === 'silent') return new Promise(() => {});
      // The plugin resolves right after calling present(); how that went arrives as an event.
      fake.emit(fake.showMode === 'fail' ? EVENTS.interstitialFailedToShow : EVENTS.interstitialShowed);
      return Promise.resolve();
    },
    showRewardVideoAd(opts) {
      calls.push({ name: 'showRewardVideoAd', opts });
      if (fake.showMode === 'reject') return Promise.reject(new Error('Reward Video is Not Ready Yet'));
      rewardedShow = deferred();
      if (fake.showMode === 'fail') fake.emit(EVENTS.rewardedFailedToShow);
      else if (fake.showMode !== 'silent') fake.emit(EVENTS.rewardedShowed);
      return rewardedShow.promise; // pending until the reward is earned, like the plugin
    },
  };

  function prepare(kind, name, opts) {
    calls.push({ name, opts });
    const load = { ...deferred(), adId: opts.adId };
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
