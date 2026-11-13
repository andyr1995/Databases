// platform.ads on native: an AdProvider backed by @capacitor-community/admob.
//
// This module owns the start-up order (consent, tracking prompt, SDK, preloading) and
// routes plugin events. The two state machines live next door:
//   fullscreen.ts  interstitial and rewarded video
//   banner.ts      the bottom banner and the height the game must keep clear

import type {
  AdMobPlugin,
  AdmobConsentInfo,
  AdmobConsentStatus,
  BannerAdPluginEvents,
  BannerAdPosition,
  BannerAdSize,
  InterstitialAdPluginEvents,
  RewardAdPluginEvents,
} from '@capacitor-community/admob';
import { type BannerTuning, createBannerController, DEFAULT_BANNER_TUNING, NO_VIEWPORT, type Viewport } from './banner.ts';
import type { AdUnits } from './config.ts';
import { createFullscreenSlot, DEFAULT_FULLSCREEN_TUNING, type FullscreenSlot, type FullscreenTuning } from './fullscreen.ts';
import type { AdProvider, Persist } from './types.ts';
import { attempt, backoffDelay, type Clock, consoleLogger, enumValue, type Logger, systemClock, withTimeout } from './util.ts';

/** The part of the AdMob plugin the bridge uses. A test passes a fake with these members. */
export type AdMobLike = Pick<
  AdMobPlugin,
  | 'addListener'
  | 'requestConsentInfo'
  | 'showConsentForm'
  | 'showPrivacyOptionsForm'
  | 'trackingAuthorizationStatus'
  | 'requestTrackingAuthorization'
  | 'initialize'
  | 'showBanner'
  | 'hideBanner'
  | 'resumeBanner'
  | 'removeBanner'
  | 'prepareInterstitial'
  | 'showInterstitial'
  | 'prepareRewardVideoAd'
  | 'showRewardVideoAd'
>;

// Event names and option values, checked at compile time against the plugin's enums
// (see enumValue) without bundling the plugin's JavaScript into the providers.
const BANNER_SIZE_CHANGED = enumValue<BannerAdPluginEvents.SizeChanged>('bannerAdSizeChanged');
const BANNER_LOADED = enumValue<BannerAdPluginEvents.Loaded>('bannerAdLoaded');
const BANNER_FAILED = enumValue<BannerAdPluginEvents.FailedToLoad>('bannerAdFailedToLoad');
const INTERSTITIAL_LOADED = enumValue<InterstitialAdPluginEvents.Loaded>('interstitialAdLoaded');
const INTERSTITIAL_SHOWED = enumValue<InterstitialAdPluginEvents.Showed>('interstitialAdShowed');
const INTERSTITIAL_FAILED_TO_SHOW = enumValue<InterstitialAdPluginEvents.FailedToShow>('interstitialAdFailedToShow');
const INTERSTITIAL_DISMISSED = enumValue<InterstitialAdPluginEvents.Dismissed>('interstitialAdDismissed');
const REWARDED_LOADED = enumValue<RewardAdPluginEvents.Loaded>('onRewardedVideoAdLoaded');
const REWARDED_SHOWED = enumValue<RewardAdPluginEvents.Showed>('onRewardedVideoAdShowed');
const REWARDED_FAILED_TO_SHOW = enumValue<RewardAdPluginEvents.FailedToShow>('onRewardedVideoAdFailedToShow');
const REWARDED_DISMISSED = enumValue<RewardAdPluginEvents.Dismissed>('onRewardedVideoAdDismissed');
const REWARDED_REWARD = enumValue<RewardAdPluginEvents.Rewarded>('onRewardedVideoAdReward');
const ADAPTIVE_BANNER = enumValue<BannerAdSize.ADAPTIVE_BANNER>('ADAPTIVE_BANNER');
const BOTTOM_CENTER = enumValue<BannerAdPosition.BOTTOM_CENTER>('BOTTOM_CENTER');
const CONSENT_REQUIRED = enumValue<AdmobConsentStatus.REQUIRED>('REQUIRED');
// The plugin does not export this enum by name, so it is reached through the field that uses it.
const PRIVACY_OPTIONS_REQUIRED = enumValue<AdmobConsentInfo['privacyOptionsRequirementStatus']>('REQUIRED');

/** Where the last consent answer is remembered between launches. */
export const CONSENT_CACHE_KEY = 'native-bridge.consent.v1';

export interface AdsTuning {
  fullscreen: FullscreenTuning;
  banner: BannerTuning;
  /**
   * How long any one non-interactive plugin call of the start-up may take (registering
   * listeners, the consent lookup, the tracking status, initialize). The two steps that wait
   * for the player, the consent form and the tracking prompt, have no limit.
   */
  stepTimeoutMs: number;
  /** While ads may not be requested, try the whole start-up again after this long (doubling). */
  startRetryBaseMs: number;
  startRetryCapMs: number;
}

/** Tests shorten the timings; anything left out keeps its default. */
export interface AdsTuningOverrides {
  fullscreen?: Partial<FullscreenTuning>;
  banner?: Partial<BannerTuning>;
  stepTimeoutMs?: number;
  startRetryBaseMs?: number;
  startRetryCapMs?: number;
}

export const DEFAULT_ADS_TUNING: AdsTuning = {
  fullscreen: DEFAULT_FULLSCREEN_TUNING,
  banner: DEFAULT_BANNER_TUNING,
  stepTimeoutMs: 10_000,
  startRetryBaseMs: 30_000,
  startRetryCapMs: 10 * 60_000,
};

export interface AdsDeps {
  admob: AdMobLike;
  /** Ad unit ids for this OS, already resolved (see resolveAdUnits). */
  units: AdUnits;
  /** app.config.json admob.testing. */
  testing: boolean;
  /** Subscribe to foreground / background changes. */
  onActive?: (cb: (active: boolean) => void) => void;
  /** Durable storage for the consent cache. */
  store?: Persist;
  viewport?: Viewport;
  clock?: Clock;
  log?: Logger;
  tuning?: AdsTuningOverrides;
}

interface Consent {
  allowed: boolean;
  /** Ask for non-personalised ads (only set when consent could not be looked up at all). */
  npa: boolean;
  privacyRequired: boolean;
}

export function createAdsProvider(deps: AdsDeps): AdProvider {
  const { admob, units } = deps;
  const clock = deps.clock ?? systemClock;
  const log = deps.log ?? consoleLogger;
  const tuning: AdsTuning = {
    ...DEFAULT_ADS_TUNING,
    ...deps.tuning,
    fullscreen: { ...DEFAULT_ADS_TUNING.fullscreen, ...deps.tuning?.fullscreen },
    banner: { ...DEFAULT_ADS_TUNING.banner, ...deps.tuning?.banner },
  };

  let listenersRegistered = false;
  let sdkStarted = false;
  let adsAllowed = false;
  let npa = false;
  let privacyRequired = false;

  let initPromise: Promise<void> | null = null;
  let running: Promise<void> | null = null;
  let startFailures = 0;
  let restartTimer: unknown = null;

  /** Consent says yes and AdMob.initialize() has run. Nothing is requested before that. */
  const canLoad = (): boolean => sdkStarted && adsAllowed;

  const host = { clock, log, tuning: tuning.fullscreen, canLoad, busy: (): boolean => interstitial.showing() || rewarded.showing() };

  const interstitial: FullscreenSlot = createFullscreenSlot(
    'interstitial',
    {
      load: () => admob.prepareInterstitial({ adId: units.interstitial, npa }),
      show: () => admob.showInterstitial({ adId: units.interstitial }),
    },
    host,
  );

  const rewarded: FullscreenSlot = createFullscreenSlot(
    'rewarded',
    {
      load: () => admob.prepareRewardVideoAd({ adId: units.rewarded, npa }),
      show: () => admob.showRewardVideoAd({ adId: units.rewarded }),
    },
    host,
  );

  const banner = createBannerController(
    {
      create: () => admob.showBanner({ adId: units.banner, adSize: ADAPTIVE_BANNER, position: BOTTOM_CENTER, margin: 0, npa }),
      hide: () => admob.hideBanner(),
      resume: () => admob.resumeBanner(),
      remove: () => admob.removeBanner(),
    },
    { clock, log, tuning: tuning.banner, viewport: deps.viewport ?? NO_VIEWPORT, canLoad },
  );

  /** A plugin event handler that cannot throw into the Capacitor bridge. */
  const guard =
    <T>(fn: (data: T | undefined) => void) =>
    (data?: T): void => {
      try {
        fn(data);
      } catch (error) {
        log('An AdMob event handler threw', error);
      }
    };

  /** Loaded events carry the ad unit id: ignore one that is not ours. */
  const isUnit = (info: { adUnitId?: string } | undefined, unit: string): boolean =>
    !info || typeof info.adUnitId !== 'string' || info.adUnitId === unit;

  async function registerListeners(): Promise<void> {
    await Promise.all([
      admob.addListener(BANNER_SIZE_CHANGED, guard((size) => banner.handleSize(Number(size && size.height)))),
      admob.addListener(BANNER_LOADED, guard(() => banner.handleLoaded())),
      admob.addListener(BANNER_FAILED, guard((error) => banner.handleFailed(error))),

      admob.addListener(INTERSTITIAL_LOADED, guard((info) => {
        if (isUnit(info, units.interstitial)) interstitial.handle('loaded');
      })),
      admob.addListener(INTERSTITIAL_SHOWED, guard(() => interstitial.handle('showed'))),
      admob.addListener(INTERSTITIAL_FAILED_TO_SHOW, guard(() => interstitial.handle('failedToShow'))),
      admob.addListener(INTERSTITIAL_DISMISSED, guard(() => interstitial.handle('dismissed'))),

      admob.addListener(REWARDED_LOADED, guard((info) => {
        if (isUnit(info, units.rewarded)) rewarded.handle('loaded');
      })),
      admob.addListener(REWARDED_SHOWED, guard(() => rewarded.handle('showed'))),
      admob.addListener(REWARDED_FAILED_TO_SHOW, guard(() => rewarded.handle('failedToShow'))),
      admob.addListener(REWARDED_DISMISSED, guard(() => rewarded.handle('dismissed'))),
      admob.addListener(REWARDED_REWARD, guard(() => rewarded.handle('rewarded'))),
    ]);
  }

  // --- consent -------------------------------------------------------------------------

  async function remember(consent: Consent): Promise<void> {
    if (!deps.store) return;
    try {
      await deps.store.set(
        CONSENT_CACHE_KEY,
        JSON.stringify({ canRequestAds: consent.allowed, privacyOptionsRequired: consent.privacyRequired }),
      );
    } catch {
      /* a missing cache only matters on a later offline launch */
    }
  }

  async function recall(): Promise<{ canRequestAds: boolean; privacyOptionsRequired: boolean } | null> {
    if (!deps.store) return null;
    try {
      const raw = await deps.store.get(CONSENT_CACHE_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw) as { canRequestAds?: unknown; privacyOptionsRequired?: unknown };
      return { canRequestAds: saved.canRequestAds === true, privacyOptionsRequired: saved.privacyOptionsRequired === true };
    } catch {
      return null;
    }
  }

  const fromInfo = (info: Pick<AdmobConsentInfo, 'canRequestAds' | 'privacyOptionsRequirementStatus'>): Consent => ({
    allowed: info.canRequestAds === true,
    npa: false,
    privacyRequired: info.privacyOptionsRequirementStatus === PRIVACY_OPTIONS_REQUIRED,
  });

  /** A plugin call that answers on its own (no player input): bounded, so init() cannot hang on it. */
  const step = <T>(label: string, call: () => Promise<T>): Promise<T> =>
    withTimeout(clock, attempt(call), tuning.stepTimeoutMs, label);

  const requestConsentInfo = (): Promise<AdmobConsentInfo> => step('requestConsentInfo', () => admob.requestConsentInfo());

  /**
   * Steps 1 and 2 of the plugin's docs/consent.md: requestConsentInfo() on every launch, then
   * showConsentForm() if a form is available and consent is still required. canRequestAds is
   * the decision.
   *
   * When the lookup itself fails (offline, timeout, no privacy message published for the app
   * id) the plugin gives no way to read what the UMP SDK still remembers, so:
   *   - if the previous successful lookup said ads may be requested, carry on, as Google's
   *     own sample does with "consent obtained in the previous session";
   *   - else, in a testing build only, carry on with non-personalised demo ads, so that a
   *     development build still shows its test ads;
   *   - else request nothing. The start-up is tried again later (see scheduleRestart).
   */
  async function settleConsent(): Promise<Consent> {
    let info: AdmobConsentInfo;
    try {
      info = await requestConsentInfo();
    } catch (error) {
      log('Consent information is unavailable', error);
      const saved = await recall();
      if (saved && saved.canRequestAds) return { allowed: true, npa: false, privacyRequired: saved.privacyOptionsRequired };
      if (deps.testing) return { allowed: true, npa: true, privacyRequired: false };
      return { allowed: false, npa: false, privacyRequired: !!saved && saved.privacyOptionsRequired };
    }

    if (info.isConsentFormAvailable && info.status === CONSENT_REQUIRED) {
      try {
        info = { ...info, ...(await attempt(() => admob.showConsentForm())) };
      } catch (error) {
        // Keep what requestConsentInfo said: canRequestAds is false while consent is missing.
        log('The consent form could not be shown', error);
      }
    }
    const consent = fromInfo(info);
    await remember(consent);
    return consent;
  }

  /**
   * docs/consent.md, "iOS tracking authorization": ask only while the status is
   * notDetermined. When an IDFA message is published in AdMob, the consent form above has
   * already shown the system prompt and the status is no longer notDetermined here.
   */
  async function askTracking(): Promise<void> {
    try {
      const tracking = await step('trackingAuthorizationStatus', () => admob.trackingAuthorizationStatus());
      if (tracking && tracking.status === 'notDetermined') {
        await attempt(() => admob.requestTrackingAuthorization());
      }
    } catch (error) {
      log('The tracking authorisation step failed', error);
    }
  }

  // --- start-up ------------------------------------------------------------------------

  /** One pass through the start-up. Returns true when ads are running. */
  async function start(): Promise<boolean> {
    if (!listenersRegistered) {
      // Before anything is requested, so the first Loaded / SizeChanged cannot be missed.
      try {
        await step('addListener', registerListeners);
        listenersRegistered = true;
      } catch (error) {
        log('AdMob listeners could not be registered; ads stay off', error);
        return false;
      }
    }

    const consent = await settleConsent();
    adsAllowed = consent.allowed;
    npa = consent.npa;
    privacyRequired = consent.privacyRequired;
    if (!adsAllowed) {
      banner.refresh();
      return false;
    }

    await askTracking();

    if (!sdkStarted) {
      try {
        await step('initialize', () => admob.initialize());
        sdkStarted = true;
      } catch (error) {
        log('AdMob.initialize failed', error);
        return false;
      }
    }

    interstitial.load();
    rewarded.load();
    banner.refresh();
    return true;
  }

  function scheduleRestart(): void {
    if (restartTimer !== null) return;
    startFailures++;
    restartTimer = clock.setTimeout(() => {
      restartTimer = null;
      void run();
    }, backoffDelay(startFailures, tuning.startRetryBaseMs, tuning.startRetryCapMs));
  }

  /** Run the start-up unless it is already running. Never rejects. */
  function run(): Promise<void> {
    if (running) return running;
    if (restartTimer !== null) {
      clock.clearTimeout(restartTimer);
      restartTimer = null;
    }
    const pass: Promise<void> = start()
      .then(
        (ok) => {
          if (ok) startFailures = 0;
          else scheduleRestart();
        },
        (error) => {
          log('Ad start-up failed', error);
          scheduleRestart();
        },
      )
      .then(() => {
        if (running === pass) running = null;
      });
    running = pass;
    return pass;
  }

  if (deps.onActive) {
    try {
      deps.onActive((active) => {
        if (!active || !initPromise) return; // nothing happens before the game calls init()
        if (!canLoad()) {
          void run();
          return;
        }
        interstitial.onActive();
        rewarded.onActive();
        banner.onActive();
      });
    } catch (error) {
      log('Could not subscribe to app state changes', error);
    }
  }

  const showSafely = (slot: FullscreenSlot): Promise<boolean> => {
    try {
      return slot.show();
    } catch (error) {
      log(`${slot.kind}: show threw`, error);
      return Promise.resolve(false);
    }
  };

  return {
    name: 'admob',

    init() {
      // Idempotent: every call gets the promise of the first start-up pass.
      if (!initPromise) initPromise = run();
      return initPromise;
    },

    // Always true on native, also while nothing is loaded, so that the game never hands out
    // a reward without an ad. "No ad right now" is expressed by the ready flags staying false.
    enabled: () => true,

    // The promises of these two resolve once the wish is recorded; when the banner is really
    // on screen (or gone) is reported through onBannerHeight.
    async showBanner() {
      try {
        banner.setWanted(true);
      } catch (error) {
        log('showBanner failed', error);
      }
    },
    async hideBanner() {
      try {
        banner.setWanted(false);
      } catch (error) {
        log('hideBanner failed', error);
      }
    },
    onBannerHeight(cb) {
      banner.onHeight(cb);
    },

    interstitialReady: () => interstitial.ready(),
    showInterstitial: () => showSafely(interstitial),
    rewardedReady: () => rewarded.ready(),
    showRewarded: () => showSafely(rewarded),

    privacyOptionsRequired: () => privacyRequired,

    async showPrivacyOptions() {
      try {
        await attempt(() => admob.showPrivacyOptionsForm());
      } catch (error) {
        log('The privacy options form could not be shown', error);
        return;
      }
      // The player may just have changed their answer.
      try {
        const consent = fromInfo(await requestConsentInfo());
        privacyRequired = consent.privacyRequired;
        await remember(consent);
        if (consent.allowed === adsAllowed) return;
        if (consent.allowed) {
          if (initPromise) void run(); // start-up was waiting for exactly this
        } else {
          adsAllowed = false;
          banner.refresh(); // takes the banner down; the ready flags are false from here on
        }
      } catch (error) {
        log('Consent information could not be refreshed', error);
      }
    },
  };
}

/**
 * Stands in when app.config.json has no ad units for this OS. It is still `enabled`, so a
 * native build can never fall back to the web behaviour of giving rewards away.
 */
export function createUnavailableAds(): AdProvider {
  return {
    name: 'admob',
    init: async () => {},
    enabled: () => true,
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
}
