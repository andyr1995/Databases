// ads.init(): the order the plugin's docs/consent.md prescribes, and what happens when a
// step fails. init() must never reject and must be safe to call again.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONSENT_CACHE_KEY, createAdsProvider, createUnavailableAds, DEFAULT_ADS_TUNING } from '../src/bridge/ads.ts';
import {
  CONSENT_OK,
  createFakeAdMob,
  createFakeAppState,
  createFakeClock,
  createMemoryStore,
  EVENTS,
  peek,
  quiet,
  settle,
  UNITS,
} from './helpers.js';

const CONSENT_NEEDED = {
  status: 'REQUIRED',
  isConsentFormAvailable: true,
  canRequestAds: false,
  privacyOptionsRequirementStatus: 'REQUIRED',
};

/** The twelve events the bridge listens for. */
const LISTENED = [
  EVENTS.bannerSize,
  EVENTS.bannerLoaded,
  EVENTS.bannerFailed,
  EVENTS.interstitialLoaded,
  EVENTS.interstitialShowed,
  EVENTS.interstitialFailedToShow,
  EVENTS.interstitialDismissed,
  EVENTS.rewardedLoaded,
  EVENTS.rewardedShowed,
  EVENTS.rewardedFailedToShow,
  EVENTS.rewardedDismissed,
  EVENTS.rewardedReward,
];

function setup(options = {}) {
  const clock = createFakeClock();
  const admob = createFakeAdMob(options.admob);
  const app = createFakeAppState();
  const store = createMemoryStore(options.stored);
  const ads = createAdsProvider({
    admob,
    units: UNITS,
    testing: options.testing ?? false,
    onActive: app.onActive,
    store,
    clock,
    log: quiet,
  });
  return { clock, admob, app, store, ads };
}

test('order: leftover banner, listeners, consent info, consent form, tracking prompt, initialize, preload', async () => {
  const { ads, admob } = setup({ admob: { consent: CONSENT_NEEDED, tracking: 'notDetermined' } });
  assert.equal(await ads.init(), undefined);

  // removeBanner (see the next test) requests nothing; everything after it does.
  const firstRequest = admob.calls.findIndex((c) => c.name !== 'addListener' && c.name !== 'removeBanner');
  assert.equal(firstRequest, 13, 'every listener is registered before anything is requested');
  for (const event of LISTENED) assert.equal(admob.listenerCount(event), 1, event);

  assert.deepEqual(admob.sequence(), [
    'removeBanner',
    'requestConsentInfo',
    'showConsentForm',
    'trackingAuthorizationStatus',
    'requestTrackingAuthorization',
    'initialize',
    'prepareInterstitial',
    'prepareRewardVideoAd',
  ]);
  assert.equal(ads.interstitialReady(), true);
  assert.equal(ads.rewardedReady(), true);
  assert.equal(ads.privacyOptionsRequired(), true, 'taken from the consent form result');
  assert.equal(admob.last('prepareInterstitial').opts.npa, false);
});

test('the first thing init() does is take down a banner left by an earlier page; once, and before the SDK starts', async () => {
  const { ads, admob, clock } = setup({ admob: { consent: new Error('offline') } });
  await ads.init();
  assert.equal(admob.calls[0].name, 'removeBanner', 'before the listeners, so a leftover is not looked at for long');
  assert.equal(admob.native.initialized, false, 'on a cold start the plugin resolves it without doing anything');

  admob.consent = CONSENT_OK;
  await clock.advance(DEFAULT_ADS_TUNING.startRetryBaseMs); // the start-up is tried again
  assert.equal(admob.count('initialize'), 1);
  assert.equal(admob.count('removeBanner'), 1, 'not repeated: by now a banner on screen would be our own');
});

test('no form when consent is not required; no prompt when tracking is already decided', async () => {
  const { ads, admob } = setup({ admob: { consent: CONSENT_OK, tracking: 'denied' } });
  await ads.init();
  assert.deepEqual(admob.sequence(), [
    'removeBanner',
    'requestConsentInfo',
    'trackingAuthorizationStatus',
    'initialize',
    'prepareInterstitial',
    'prepareRewardVideoAd',
  ]);
  assert.equal(ads.privacyOptionsRequired(), false);
});

test('no form when consent is required but no form is available', async () => {
  const { ads, admob } = setup({ admob: { consent: { ...CONSENT_NEEDED, isConsentFormAvailable: false } } });
  await ads.init();
  assert.deepEqual(admob.sequence(), ['removeBanner', 'requestConsentInfo']);
});

test('no form when consent was already obtained, although a form is available', async () => {
  const obtained = { status: 'OBTAINED', isConsentFormAvailable: true, canRequestAds: true, privacyOptionsRequirementStatus: 'REQUIRED' };
  const { ads, admob } = setup({ admob: { consent: obtained } });
  await ads.init();
  assert.equal(admob.count('showConsentForm'), 0, 'the form is for players who have not answered yet');
  assert.equal(admob.count('initialize'), 1);
  assert.equal(ads.privacyOptionsRequired(), true);
});

test('when ads may not be requested: no tracking prompt, no SDK start, nothing loaded', async () => {
  const { ads, admob } = setup({
    admob: {
      consent: CONSENT_NEEDED,
      consentForm: { status: 'REQUIRED', canRequestAds: false, privacyOptionsRequirementStatus: 'REQUIRED' },
      tracking: 'notDetermined',
    },
  });
  await ads.init();
  assert.deepEqual(admob.sequence(), ['removeBanner', 'requestConsentInfo', 'showConsentForm']);
  assert.equal(ads.enabled(), true);
  assert.equal(ads.interstitialReady(), false);
  assert.equal(ads.rewardedReady(), false);
  assert.equal(await ads.showInterstitial(), false);
  assert.equal(await ads.showRewarded(), false);

  await ads.showBanner();
  await settle();
  assert.equal(admob.count('showBanner'), 0, 'no banner request either');
});

test('init() is idempotent', async () => {
  const { ads, admob } = setup();
  const first = ads.init();
  const second = ads.init();
  assert.equal(first, second);
  await Promise.all([first, second, ads.init()]);
  assert.equal(admob.count('requestConsentInfo'), 1);
  assert.equal(admob.count('initialize'), 1);
  assert.equal(admob.count('prepareInterstitial'), 1);
  assert.equal(admob.count('removeBanner'), 1);
  assert.equal(admob.listenerCount(EVENTS.rewardedReward), 1);
});

test('init() resolves, and never rejects, when every plugin call fails', async () => {
  const { ads, admob } = setup();
  for (const name of Object.keys(admob)) {
    if (typeof admob[name] === 'function' && /^(add|request|show|tracking|initialize|prepare|hide|resume|remove)/.test(name)) {
      admob[name] = () => Promise.reject(new Error(`${name} is not implemented on ios`));
    }
  }
  assert.equal(await ads.init(), undefined);
  assert.equal(ads.interstitialReady(), false);
  assert.equal(await ads.showRewarded(), false);
  await ads.showBanner();
  await ads.hideBanner();
  await ads.showPrivacyOptions();
});

test('init() resolves when plugin calls throw synchronously', async () => {
  const { ads, admob } = setup();
  admob.addListener = () => {
    throw new Error('no bridge');
  };
  assert.equal(await ads.init(), undefined);
  assert.equal(ads.rewardedReady(), false);
});

test('listeners that cannot be registered keep ads off', async () => {
  const { ads, admob } = setup();
  admob.listenersFail = true;
  await ads.init();
  assert.deepEqual(admob.sequence(), ['removeBanner'], 'nothing is requested without listeners');
  assert.equal(ads.interstitialReady(), false);
});

test('a start-up that is tried again does not register the listeners a second time', async () => {
  const { ads, admob, app } = setup({ admob: { consent: new Error('offline') } });
  await ads.init(); // listeners registered, then stopped at the consent lookup
  assert.equal(admob.count('addListener'), LISTENED.length);

  admob.consent = CONSENT_OK;
  app.fire(true); // second pass, this time all the way
  await settle();
  assert.equal(ads.interstitialReady(), true);
  assert.equal(admob.count('addListener'), LISTENED.length);
  for (const event of LISTENED) assert.equal(admob.listenerCount(event), 1, event);
});

test('listeners that failed to register are registered on the next pass', async () => {
  const { ads, admob, clock } = setup();
  admob.listenersFail = true;
  await ads.init();
  admob.listenersFail = false;
  await clock.advance(DEFAULT_ADS_TUNING.startRetryBaseMs);
  for (const event of LISTENED) assert.equal(admob.listenerCount(event), 1, event);
  assert.equal(ads.interstitialReady(), true);
});

test('a failing tracking step does not stop the start-up', async () => {
  const { ads, admob } = setup();
  admob.trackingAuthorizationStatus = () => Promise.reject(new Error("trackingAuthorizationStatus can't get status"));
  await ads.init();
  assert.deepEqual(admob.sequence().slice(-3), ['initialize', 'prepareInterstitial', 'prepareRewardVideoAd']);
});

test('a failing initialize keeps ads off and is retried later', async () => {
  const { ads, admob, clock } = setup();
  admob.initializeFails = true;
  await ads.init();
  assert.equal(admob.count('prepareInterstitial'), 0);

  admob.initializeFails = false;
  await clock.advance(DEFAULT_ADS_TUNING.startRetryBaseMs);
  assert.equal(admob.count('initialize'), 2);
  assert.equal(ads.interstitialReady(), true);
});

// --- when the consent lookup itself fails --------------------------------------------------------

test('consent lookup fails, nothing remembered: no ads, retried when the app becomes active', async () => {
  const { ads, admob, app, store } = setup({ admob: { consent: new Error('Request consent info failed') } });
  await ads.init();
  assert.deepEqual(admob.sequence(), ['removeBanner', 'requestConsentInfo']);
  assert.equal(ads.rewardedReady(), false);

  admob.consent = CONSENT_OK; // back online
  app.fire(true);
  await settle();
  assert.deepEqual(admob.sequence(), [
    'removeBanner',
    'requestConsentInfo',
    'requestConsentInfo',
    'trackingAuthorizationStatus',
    'initialize',
    'prepareInterstitial',
    'prepareRewardVideoAd',
  ]);
  assert.equal(ads.rewardedReady(), true);
  assert.deepEqual(JSON.parse(store.data.get(CONSENT_CACHE_KEY)), { canRequestAds: true, privacyOptionsRequired: false });
});

test('consent lookup fails, nothing remembered: also retried on a timer, with backoff', async () => {
  const { ads, admob, clock } = setup({ admob: { consent: new Error('offline') } });
  await ads.init();
  await clock.advance(DEFAULT_ADS_TUNING.startRetryBaseMs - 1);
  assert.equal(admob.count('requestConsentInfo'), 1);
  await clock.advance(1);
  assert.equal(admob.count('requestConsentInfo'), 2);
  await clock.advance(2 * DEFAULT_ADS_TUNING.startRetryBaseMs - 1);
  assert.equal(admob.count('requestConsentInfo'), 2);
  await clock.advance(1);
  assert.equal(admob.count('requestConsentInfo'), 3);
  assert.equal(admob.count('initialize'), 0);
});

test('consent lookup fails, but the last launch was allowed to request ads: carry on', async () => {
  const { ads, admob } = setup({
    admob: { consent: new Error('offline') },
    stored: { [CONSENT_CACHE_KEY]: JSON.stringify({ canRequestAds: true, privacyOptionsRequired: true }) },
  });
  await ads.init();
  assert.deepEqual(admob.sequence().slice(-3), ['initialize', 'prepareInterstitial', 'prepareRewardVideoAd']);
  assert.equal(admob.last('prepareInterstitial').opts.npa, false);
  assert.equal(ads.privacyOptionsRequired(), true);
});

test('consent lookup fails, and the last launch was NOT allowed: still no ads', async () => {
  const { ads, admob } = setup({
    admob: { consent: new Error('offline') },
    stored: { [CONSENT_CACHE_KEY]: JSON.stringify({ canRequestAds: false, privacyOptionsRequired: true }) },
  });
  await ads.init();
  assert.equal(admob.count('initialize'), 0);
  assert.equal(ads.privacyOptionsRequired(), true);
});

test('consent lookup fails in a testing build: non-personalised demo ads', async () => {
  const { ads, admob } = setup({ admob: { consent: new Error('no form(s) configured for the input app ID') }, testing: true });
  await ads.init();
  assert.deepEqual(admob.sequence().slice(-3), ['initialize', 'prepareInterstitial', 'prepareRewardVideoAd']);
  assert.equal(admob.last('prepareInterstitial').opts.npa, true);
  assert.equal(admob.last('prepareRewardVideoAd').opts.npa, true);
});

test('a consent lookup that never answers does not hang init()', async () => {
  const { ads, admob, clock } = setup({ admob: { consent: 'hang' } });
  const init = ads.init();
  await clock.advance(DEFAULT_ADS_TUNING.stepTimeoutMs - 1);
  assert.equal(await peek(init), 'pending');
  await clock.advance(1);
  assert.equal(await init, undefined);
  assert.equal(admob.count('initialize'), 0);
});

test('a consent form that cannot be shown leaves ads off', async () => {
  const { ads, admob } = setup({ admob: { consent: CONSENT_NEEDED, consentForm: new Error('Consent Form not available') } });
  await ads.init();
  assert.deepEqual(admob.sequence(), ['removeBanner', 'requestConsentInfo', 'showConsentForm']);
  assert.equal(ads.privacyOptionsRequired(), true);
});

test('nothing starts on app activation before the game has called init()', async () => {
  const { admob, app } = setup();
  app.fire(true);
  await settle();
  assert.equal(admob.calls.length, 0);
});

// --- privacy options ------------------------------------------------------------------------------

test('privacyOptionsRequired comes from the consent information', async () => {
  const required = setup({ admob: { consent: { ...CONSENT_OK, status: 'OBTAINED', privacyOptionsRequirementStatus: 'REQUIRED' } } });
  assert.equal(required.ads.privacyOptionsRequired(), false, 'unknown before init');
  await required.ads.init();
  assert.equal(required.ads.privacyOptionsRequired(), true);

  const notRequired = setup();
  await notRequired.ads.init();
  assert.equal(notRequired.ads.privacyOptionsRequired(), false);
});

test('showPrivacyOptions opens the form, then refreshes the consent state', async () => {
  const { ads, admob } = setup({ admob: { consent: { ...CONSENT_OK, status: 'OBTAINED', privacyOptionsRequirementStatus: 'REQUIRED' } } });
  await ads.init();
  const before = admob.count('requestConsentInfo');
  assert.equal(await ads.showPrivacyOptions(), undefined);
  assert.equal(admob.count('showPrivacyOptionsForm'), 1);
  assert.equal(admob.count('requestConsentInfo'), before + 1);
  assert.equal(ads.interstitialReady(), true);
});

test('consent withdrawn in the privacy options: ads stop, the banner comes down', async () => {
  const { ads, admob } = setup({ admob: { consent: { ...CONSENT_OK, status: 'OBTAINED', privacyOptionsRequirementStatus: 'REQUIRED' } } });
  const heights = [];
  ads.onBannerHeight((h) => heights.push(h));
  await ads.init();
  await ads.showBanner();
  admob.bannerArrives(60);
  assert.deepEqual(heights, [60]);

  admob.consent = { ...admob.consent, canRequestAds: false };
  await ads.showPrivacyOptions();
  await settle();
  assert.equal(ads.interstitialReady(), false);
  assert.equal(ads.rewardedReady(), false);
  assert.equal(admob.count('hideBanner'), 1);
  assert.equal(admob.bannerOnScreen(), false);
  assert.deepEqual(heights, [60, 0]);
});

test('showPrivacyOptions never rejects', async () => {
  const { ads, admob } = setup();
  await ads.init();
  admob.showPrivacyOptionsForm = () => Promise.reject(new Error('No ViewController'));
  assert.equal(await ads.showPrivacyOptions(), undefined);
});

// --- the stand-in used when there are no ad units for the OS ---------------------------------------

test('the unavailable provider is enabled but never ready', async () => {
  const ads = createUnavailableAds();
  assert.equal(ads.enabled(), true);
  assert.equal(await ads.init(), undefined);
  assert.equal(ads.interstitialReady(), false);
  assert.equal(ads.rewardedReady(), false);
  assert.equal(await ads.showInterstitial(), false);
  assert.equal(await ads.showRewarded(), false);
});
