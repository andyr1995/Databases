// The Android test doubles themselves. The points on which they must not be wrong are pinned
// here, each with the place in the plugin source it was read from:
//   admob     @capacitor-community/admob 8.3.0, android/src/main/java/com/getcapacitor/community/admob
//   app       @capacitor/app 8.1.2 AppPlugin.java; @capacitor/android 8.6.2 BridgeActivity.java
//   purchases @capgo/native-purchases 8.9.16 NativePurchasesPlugin.java
//
// These tests check the doubles against what was read then. Whether the plugins that are
// installed NOW still read that way is checked in test/plugin-sources.test.js, against their Java.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GOOGLE_ANDROID_DEMO_UNITS as UNITS } from '../src/bridge/config.ts';
import { createFakeAndroidAdMob, createFakeAndroidApp, createFakePlayPurchases, flush } from './helpers-android.js';
import { EVENTS, peek } from './helpers.js';

function heard(admob, ...events) {
  const log = [];
  for (const event of events) admob.addListener(event, (data) => log.push([event, data]));
  return log;
}

// --- AdMob: full-screen ads ------------------------------------------------------------------------

test('android fake: a prepare call is answered before its Loaded event is sent', async () => {
  const admob = createFakeAndroidAdMob();
  const order = [];
  await admob.addListener(EVENTS.interstitialLoaded, () => order.push('event'));
  // InterstitialAdCallbackAndListeners.kt: call.resolve(adInfo), then notifyListeners(Loaded)
  await admob.prepareInterstitial({ adId: UNITS.interstitial }).then(() => order.push('answer'));
  await flush();
  assert.deepEqual(order, ['answer', 'event']);
  assert.equal(admob.preparedCount('interstitial'), 1);

  const failing = createFakeAndroidAdMob({ loads: 'manual' });
  const failed = failing.prepareRewardVideoAd({ adId: UNITS.rewarded });
  await flush();
  failing.loadFail('rewarded');
  await assert.rejects(failed, /No fill/);
});

test('android fake: show without a prepared ad rejects and emits FailedToLoad; there is no "already showing" guard', async () => {
  const admob = createFakeAndroidAdMob();
  const log = heard(admob, EVENTS.interstitialFailedToLoad, EVENTS.interstitialFailedToShow, EVENTS.interstitialShowed);
  // AdInterstitialExecutor.java:63-69
  await assert.rejects(admob.showInterstitial({ adId: UNITS.interstitial }), /No Interstitial can be shown/);
  assert.deepEqual(log.map(([event]) => event), [EVENTS.interstitialFailedToLoad]);

  await admob.prepareInterstitial({ adId: UNITS.interstitial });
  await admob.showInterstitial({ adId: UNITS.interstitial }); // resolves once show() was called (:83-84)
  assert.equal(log.at(-1)[0], EVENTS.interstitialFailedToLoad, 'answered before the ad has reported that it is up');
  await flush();
  assert.equal(log.at(-1)[0], EVENTS.interstitialShowed);
  assert.equal(admob.adOnScreen('interstitial'), true);
  assert.equal(admob.preparedCount('interstitial'), 1, 'the ad on screen keeps its entry until it closes');

  // A second show of the same ad is not refused by the plugin. The SDK reports it through the
  // callback just attached, whose onCompleted deletes the entry.
  await admob.showInterstitial({ adId: UNITS.interstitial });
  assert.equal(log.at(-1)[0], EVENTS.interstitialFailedToShow);
  assert.equal(admob.presentations('interstitial'), 1);
  assert.equal(admob.preparedCount('interstitial'), 0);
});

test('android fake: closing an ad deletes what is filed under its ad unit by then', async () => {
  const admob = createFakeAndroidAdMob();
  await admob.prepareRewardVideoAd({ adId: UNITS.rewarded });
  admob.showRewardVideoAd({ adId: UNITS.rewarded });
  await flush();
  await admob.prepareRewardVideoAd({ adId: UNITS.rewarded }); // replaces the entry (RewardedAdCallbackAndListeners.kt:146)
  admob.dismiss('rewarded'); // AdRewardExecutor.java:72-78
  assert.equal(admob.preparedCount('rewarded'), 0, 'the newer ad went with it');
  await assert.rejects(admob.showRewardVideoAd({ adId: UNITS.rewarded }), /No Reward Video Ad can be shown/);
});

test('android fake: the rewarded show call settles only with the reward, after the Rewarded event', async () => {
  const admob = createFakeAndroidAdMob();
  await admob.prepareRewardVideoAd({ adId: UNITS.rewarded });
  const closedEarly = admob.showRewardVideoAd({ adId: UNITS.rewarded });
  await flush();
  admob.dismiss('rewarded');
  assert.equal(await peek(closedEarly), 'pending');

  await admob.prepareRewardVideoAd({ adId: UNITS.rewarded });
  const order = [];
  await admob.addListener(EVENTS.rewardedReward, () => order.push('event'));
  const watched = admob.showRewardVideoAd({ adId: UNITS.rewarded }).then((item) => (order.push('answer'), item));
  await flush();
  admob.earnReward(); // RewardedAdCallbackAndListeners.kt:109-115
  assert.deepEqual(await watched, { type: 'coins', amount: 1 });
  assert.deepEqual(order, ['event', 'answer']);
});

test('android fake: tracking is always authorized; initialize answers from the UI thread, or rejects without a banner parent', async () => {
  const admob = createFakeAndroidAdMob();
  assert.deepEqual(await admob.trackingAuthorizationStatus(), { status: 'authorized' }); // AdMob.java:172-176
  assert.equal(await admob.requestTrackingAuthorization(), undefined);
  assert.equal(await admob.initialize(), undefined);
  assert.equal(admob.native.initialized, true);

  admob.bannerParentMissing = true;
  await assert.rejects(admob.initialize(), /banner parent view never appeared/); // AdMob.java:147-153
});

// --- AdMob: banner ---------------------------------------------------------------------------------

test('android fake: showBanner attaches the view at once and reports the ad size in dp when it has loaded', async () => {
  const admob = createFakeAndroidAdMob();
  const log = heard(admob, EVENTS.bannerSize, EVENTS.bannerLoaded);
  assert.equal(await admob.showBanner({ adId: UNITS.banner }), undefined); // BannerExecutor.java:269-271
  await flush();
  assert.equal(admob.native.layout.attached, true); // :464-467
  assert.equal(admob.bannerOnScreen(), false, 'nothing to see before the ad has loaded');
  admob.bannerArrives();
  assert.deepEqual(log, [
    [EVENTS.bannerSize, { width: 390, height: 60 }], // BannerAdSizeInfo.kt:16, AdSize.getHeight()
    [EVENTS.bannerLoaded, {}],
  ]);
  assert.equal(admob.bannerOnScreen(), true);
});

test('android fake: showBanner while the plugin holds a view never answers and only reloads that view', async () => {
  const admob = createFakeAndroidAdMob();
  await admob.showBanner({ adId: UNITS.banner });
  await admob.hideBanner().catch(() => {});
  const view = admob.native.adView;
  // BannerExecutor.java:180-183: updateExistingAdView(adOptions); return;
  assert.equal(await peek(admob.showBanner({ adId: UNITS.banner })), 'pending');
  await flush();
  assert.equal(admob.native.adView, view);
  assert.equal(view.reloads, 1);
  assert.equal(admob.native.layout.visible, false, 'a hidden banner stays hidden');
});

test('android fake: removeBanner answers before the view is gone; a showBanner sent on that answer is swallowed', async () => {
  const admob = createFakeAndroidAdMob();
  const log = heard(admob, EVENTS.bannerSize);
  await admob.showBanner({ adId: UNITS.banner });
  await flush();
  const old = admob.native.adView;

  await admob.removeBanner(); // BannerExecutor.java:321-340: call.resolve() outside the UI task
  assert.equal(admob.native.adView, old, 'still there when the call has answered');
  const swallowed = admob.showBanner({ adId: UNITS.banner });
  await flush();
  assert.equal(admob.native.adView, null, 'the removal went ahead');
  assert.deepEqual(log.at(-1), [EVENTS.bannerSize, { width: 0, height: 0 }]); // :334-335
  assert.equal(await peek(swallowed), 'pending', 'the hazard the bridge has to avoid');

  // A view that is still loading is found as well (iOS only finds one that is on screen).
  assert.equal(await admob.removeBanner(), undefined, 'and without a view it just resolves');
});

test('android fake: hideBanner rejects without a view, and crashes the app when the view goes away under it', async () => {
  const admob = createFakeAndroidAdMob();
  await assert.rejects(admob.hideBanner(), /never shown/); // BannerExecutor.java:278-281

  await admob.showBanner({ adId: UNITS.banner });
  await flush();
  admob.bannerArrives();
  const log = heard(admob, EVENTS.bannerSize);
  await admob.hideBanner();
  assert.equal(admob.bannerOnScreen(), false);
  assert.equal(admob.native.adView.paused, true); // :287
  assert.deepEqual(log, [[EVENTS.bannerSize, { width: 0, height: 0 }]]);

  // :284-287: the UI task calls mAdView.pause() without looking. A removal (or a failed load)
  // that reaches the UI thread first leaves it null.
  admob.removeBanner();
  admob.hideBanner();
  await flush();
  assert.match(admob.native.crashed, /NullPointerException/);
});

test('android fake: resumeBanner answers at once, with or without a view; the size event is the only proof', async () => {
  const admob = createFakeAndroidAdMob();
  assert.equal(await admob.resumeBanner(), undefined, 'no view: iOS would reject here'); // BannerExecutor.java:301-319

  await admob.showBanner({ adId: UNITS.banner });
  await flush();
  admob.bannerArrives();
  await admob.hideBanner();
  const log = heard(admob, EVENTS.bannerSize);
  await admob.resumeBanner();
  assert.equal(admob.bannerOnScreen(), false, 'answered before the UI thread has un-hidden it');
  await flush();
  assert.equal(admob.bannerOnScreen(), true);
  assert.deepEqual(log, [[EVENTS.bannerSize, { width: 390, height: 60 }]]);
});

test('android fake: a failed load removes the view; a page reload keeps what the plugin holds', async () => {
  const admob = createFakeAndroidAdMob();
  await admob.showBanner({ adId: UNITS.banner });
  await flush();
  const log = heard(admob, EVENTS.bannerSize, EVENTS.bannerFailed);
  admob.bannerFails(); // BannerExecutor.java:401-425
  assert.equal(admob.native.adView, null);
  assert.deepEqual(log.map(([event]) => event), [EVENTS.bannerSize, EVENTS.bannerFailed]);

  await admob.showBanner({ adId: UNITS.banner });
  await flush();
  admob.bannerArrives();
  admob.reloadPage(); // Bridge.reset(): listeners only
  assert.equal(admob.listenerCount(EVENTS.bannerSize), 0);
  assert.equal(admob.bannerOnScreen(), true);
});

// --- App ---------------------------------------------------------------------------------------------

test('android app fake: active follows onResume / onStop; pause and resume follow the activity; Back is swallowed', async () => {
  const app = createFakeAndroidApp();
  const log = [];
  await app.addListener('appStateChange', (state) => log.push(state.isActive));
  await app.addListener('pause', () => log.push('pause'));
  await app.addListener('resume', () => log.push('resume'));

  app.resumed(); // the launch: AppPlugin only sends 'resume' once the activity has been paused
  app.paused(); // an ad on top: paused, not stopped
  app.resumed();
  app.paused();
  app.stopped(); // Home
  app.resumed();
  assert.deepEqual(log, [true, 'pause', true, 'resume', 'pause', false, true, 'resume']);

  // AppPlugin.java:46-60. No listener: history back if there is any, else nothing at all.
  app.pressBack();
  assert.equal(app.wentBackInHistory + app.minimized, 0);
  app.canGoBack = true;
  app.pressBack();
  assert.equal(app.wentBackInHistory, 1);
  const presses = [];
  await app.addListener('backButton', (event) => presses.push(event));
  app.pressBack();
  assert.deepEqual(presses, [{ canGoBack: true }]);
  assert.equal(app.wentBackInHistory, 1, 'with a listener the plugin leaves everything to the page');
});

// --- Google Play ---------------------------------------------------------------------------------------

test('play fake: a purchase is acknowledged by default and says so; a consumable is consumed', async () => {
  const store = createFakePlayPurchases();
  const bought = await store.purchaseProduct({ productIdentifier: 'remove_ads', productType: 'inapp' });
  assert.equal(bought.purchaseState, '1');
  assert.equal(bought.isAcknowledged, true); // handlePurchase(): ACKNOWLEDGE, then ret.put("isAcknowledged", true)
  assert.equal(bought.transactionId, bought.purchaseToken);
  assert.deepEqual((await store.getPurchases({ productType: 'inapp' })).purchases.map((p) => p.isAcknowledged), [true]);
  await assert.rejects(store.purchaseProduct({ productIdentifier: 'remove_ads' }), { code: 'ITEM_ALREADY_OWNED' });

  const consumable = createFakePlayPurchases();
  await consumable.purchaseProduct({ productIdentifier: 'remove_ads', isConsumable: true });
  assert.deepEqual((await consumable.getPurchases()).purchases, [], 'gone again: it could be bought a second time');
});

test('play fake: the purchase resolves even when the acknowledgement failed', async () => {
  const store = createFakePlayPurchases();
  store.play.acknowledgeFails = true;
  const bought = await store.purchaseProduct({ productIdentifier: 'remove_ads' });
  assert.equal(bought.isAcknowledged, false); // "Automatic purchase finish failed; isAcknowledged stays false"
  await assert.rejects(store.acknowledgePurchase({ purchaseToken: bought.purchaseToken }), /Failed to acknowledge/);
  store.play.acknowledgeFails = false;
  assert.equal(await store.acknowledgePurchase({ purchaseToken: bought.purchaseToken }), undefined);
  assert.equal(store.play.purchases[0].acknowledged, true);
});

test('play fake: cancelled, pending and failed purchases reject with the reason in the code or the message', async () => {
  const cancel = createFakePlayPurchases({ sheet: 'cancel' });
  // handlePurchasesUpdated(): reject("Purchase is not purchased", billingResponseCodeName(code))
  await assert.rejects(cancel.purchaseProduct({ productIdentifier: 'remove_ads' }), { message: 'Purchase is not purchased', code: 'USER_CANCELED' });
  assert.deepEqual(cancel.play.purchases, []);

  const pending = createFakePlayPurchases({ sheet: 'pending' });
  await assert.rejects(pending.purchaseProduct({ productIdentifier: 'remove_ads' }), { message: 'Purchase is pending' });
  const listed = (await pending.getPurchases({ productType: 'inapp' })).purchases;
  assert.deepEqual(listed.map((p) => [p.productIdentifier, p.purchaseState, p.isAcknowledged]), [['remove_ads', '2', false]]);

  const down = createFakePlayPurchases({ sheet: 'error' });
  await assert.rejects(down.purchaseProduct({ productIdentifier: 'remove_ads' }), { code: 'SERVICE_UNAVAILABLE' });
  await assert.rejects(down.purchaseProduct({ productIdentifier: 'nothing' }), /Product not found/);
});

test('play fake: restorePurchases acknowledges what is paid for and returns nothing; lookups reject when Play is unreachable', async () => {
  const store = createFakePlayPurchases();
  store.ownedElsewhere('remove_ads', { acknowledged: false });
  assert.equal(await store.restorePurchases(), undefined); // restoreWithClient(): call.resolve()
  assert.equal(store.play.purchases[0].acknowledged, true);

  store.play.unavailable = true;
  for (const call of [
    () => store.getPurchases({ productType: 'inapp' }),
    () => store.getProduct({ productIdentifier: 'remove_ads', productType: 'inapp' }),
    () => store.purchaseProduct({ productIdentifier: 'remove_ads' }),
    () => store.restorePurchases(),
  ]) {
    await assert.rejects(call(), /BILLING_SETUP_FAILED/);
  }
});

test('play fake: a call that arrives while a lookup is unanswered ends that lookup for good', async () => {
  // initBillingClient(): closeBillingClientLocked() -> billingClient.endConnection(), which
  // drops the work queued on the connection. Only an open purchase sheet or an
  // acknowledgement in flight spares a connection; getPurchases and getProduct have neither.
  const store = createFakePlayPurchases();
  store.ownedElsewhere('remove_ads');
  const first = store.getPurchases({ productType: 'inapp' });
  const second = store.getProduct({ productIdentifier: 'remove_ads', productType: 'inapp' });
  assert.equal((await second).product.priceString, '£2.99');
  assert.equal(await peek(first), 'pending', 'the first lookup never answers');
  assert.equal(store.play.lookupsCutOff, 1);

  // One after the other they both answer.
  assert.equal((await store.getPurchases({ productType: 'inapp' })).purchases.length, 1);
  assert.equal((await store.getProduct({ productIdentifier: 'remove_ads', productType: 'inapp' })).product.priceString, '£2.99');
  assert.equal(store.play.lookupsCutOff, 1);

  // Every kind of call that goes to Google Play does it, a failing one included ...
  for (const next of [
    () => store.getPurchases({ productType: 'inapp' }),
    () => store.purchaseProduct({ productIdentifier: 'nothing' }).catch(() => {}),
    () => store.restorePurchases(),
    () => store.acknowledgePurchase({ purchaseToken: 'unknown' }).catch(() => {}),
  ]) {
    const before = store.play.lookupsCutOff;
    const lookup = store.getProduct({ productIdentifier: 'remove_ads', productType: 'inapp' });
    await next();
    assert.equal(await peek(lookup), 'pending');
    assert.equal(store.play.lookupsCutOff, before + 1);
    await flush();
  }
  // ... but not a call the plugin answers before it gets as far as a connection.
  const spared = store.getProduct({ productIdentifier: 'remove_ads', productType: 'inapp' });
  await assert.rejects(store.acknowledgePurchase({}), /purchaseToken is required/);
  assert.deepEqual(await store.getPurchases({ productType: 'neither' }), { purchases: [] });
  assert.equal((await spared).product.priceString, '£2.99');
});

test('play fake: held lookups answer when told to, with what Play says at that moment', async () => {
  const store = createFakePlayPurchases({ holdLookups: true });
  const lookup = store.getPurchases({ productType: 'inapp' });
  assert.equal(await peek(lookup), 'pending');
  assert.equal(store.heldLookups(), 1);
  store.ownedElsewhere('remove_ads');
  store.answerLookups();
  assert.equal((await lookup).purchases.length, 1);
  assert.equal(store.heldLookups(), 0);

  store.play.unavailable = true;
  const failing = store.getProduct({ productIdentifier: 'remove_ads', productType: 'inapp' });
  store.answerLookups();
  await assert.rejects(failing, /BILLING_SETUP_FAILED/);
});
