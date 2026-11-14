// platform.iap: the single non-consumable "Remove Ads" product.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIapProvider } from '../src/bridge/iap.ts';
import { createFakePlayPurchases } from './helpers-android.js';
import { createFakeAppState, createFakeClock, peek, quiet, settle } from './helpers.js';

const PRODUCT = 'remove_ads';
const entitlement = (extra = {}) => ({ transactionId: '1', productIdentifier: PRODUCT, purchaseDate: '2026-01-01T00:00:00Z', ...extra });

function setup(overrides = {}) {
  const calls = [];
  const purchases = {
    calls,
    owned: [],
    async getProduct(opts) {
      calls.push({ name: 'getProduct', opts });
      return { product: { identifier: PRODUCT, priceString: '£2.99', price: 2.99 } };
    },
    async getPurchases(opts) {
      calls.push({ name: 'getPurchases', opts });
      return { purchases: purchases.owned };
    },
    async purchaseProduct(opts) {
      calls.push({ name: 'purchaseProduct', opts });
      purchases.owned = [entitlement()];
      return entitlement();
    },
    async restorePurchases() {
      calls.push({ name: 'restorePurchases' });
    },
    ...overrides,
  };
  const clock = createFakeClock();
  const iap = createIapProvider(purchases, PRODUCT, { clock, log: quiet });
  return { purchases, iap, clock, calls };
}

const rejecting = (message) => () => Promise.reject(new Error(message));

test('available on native', () => {
  assert.equal(setup().iap.available(), true);
});

test('product() resolves the localised price string', async () => {
  const { iap, calls } = setup();
  assert.deepEqual(await iap.product(), { price: '£2.99' });
  assert.deepEqual(calls[0].opts, { productIdentifier: PRODUCT, productType: 'inapp' });
});

test('product() resolves null when the store is unreachable or the product is unknown', async () => {
  assert.equal(await setup({ getProduct: rejecting('Product not found') }).iap.product(), null);
  assert.equal(await setup({ getProduct: async () => ({ product: { priceString: '' } }) }).iap.product(), null);
  assert.equal(await setup({ getProduct: async () => ({}) }).iap.product(), null);
  assert.equal(
    await setup({
      getProduct: () => {
        throw new Error('no bridge');
      },
    }).iap.product(),
    null,
  );
});

test('product() gives up on a store that never answers', async () => {
  const { iap, clock } = setup({ getProduct: () => new Promise(() => {}) });
  const price = iap.product();
  await clock.advance(14_999);
  assert.equal(await peek(price), 'pending');
  await clock.advance(1);
  assert.equal(await price, null);
});

test('owned() reads the current entitlements', async () => {
  const { iap, purchases, calls } = setup();
  assert.equal(await iap.owned(), false);
  assert.deepEqual(calls.at(-1).opts, { productType: 'inapp', onlyCurrentEntitlements: true });

  purchases.owned = [entitlement({ productIdentifier: 'something_else' })];
  assert.equal(await iap.owned(), false);

  purchases.owned = [entitlement({ productIdentifier: 'something_else' }), entitlement()];
  assert.equal(await iap.owned(), true);

  purchases.owned = [entitlement({ revocationDate: '2026-02-01T00:00:00Z' })];
  assert.equal(await iap.owned(), false, 'a refunded purchase is not an entitlement');
});

test('owned() resolves false when the lookup fails', async () => {
  assert.equal(await setup({ getPurchases: rejecting('StoreKit unavailable') }).iap.owned(), false);
  assert.equal(await setup({ getPurchases: async () => ({}) }).iap.owned(), false);
  assert.equal(await setup({ getPurchases: async () => null }).iap.owned(), false);
});

test('purchase(): a verified transaction is "purchased"', async () => {
  const { iap, calls } = setup();
  assert.equal(await iap.purchase(), 'purchased');
  assert.deepEqual(calls.at(-1).opts, { productIdentifier: PRODUCT, productType: 'inapp', quantity: 1 });
  assert.equal(await iap.owned(), true);
});

test('purchase(): result mapping for every way the plugin rejects', async () => {
  const cases = [
    ['User cancelled', 'cancelled'], // Product.PurchaseResult.userCancelled
    ['Purchase canceled by user', 'cancelled'],
    ['Transaction pending', 'cancelled'], // Ask to Buy: not bought yet, and not an error to show
    ['Cannot find product for id remove_ads', 'failed'],
    ['Unknown error', 'failed'],
    ['The network connection was lost.', 'failed'],
    ['', 'failed'],
  ];
  for (const [message, expected] of cases) {
    assert.equal(await setup({ purchaseProduct: rejecting(message) }).iap.purchase(), expected, message);
  }
  const weird = setup({ purchaseProduct: () => Promise.reject({ errorMessage: 'User cancelled' }) });
  assert.equal(await weird.iap.purchase(), 'cancelled', 'a plain object rejection, as the Capacitor bridge can produce');
  const thrown = setup({
    purchaseProduct: () => {
      throw new Error('no bridge');
    },
  });
  assert.equal(await thrown.iap.purchase(), 'failed');
});

test('purchase(): a second call while the sheet is up joins the first', async () => {
  let finish;
  const { iap, calls } = setup({
    purchaseProduct(opts) {
      calls.push({ name: 'purchaseProduct', opts });
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const first = iap.purchase();
  const second = iap.purchase();
  finish({ transactionId: '1', productIdentifier: PRODUCT });
  assert.deepEqual(await Promise.all([first, second]), ['purchased', 'purchased']);
  assert.equal(calls.filter((c) => c.name === 'purchaseProduct').length, 1);

  const later = iap.purchase();
  assert.equal(calls.filter((c) => c.name === 'purchaseProduct').length, 2, 'a later purchase starts afresh');
  finish({ transactionId: '2', productIdentifier: PRODUCT });
  assert.equal(await later, 'purchased');
});

test('iOS: nothing is ever acknowledged, swept or timed', async () => {
  const { iap, purchases, clock, calls } = setup({
    async acknowledgePurchase() {
      calls.push({ name: 'acknowledgePurchase' });
    },
  });
  assert.equal(clock.pending(), 0, 'no look at the store that the game did not ask for');
  // Android-only fields turning up in an iOS answer change nothing.
  purchases.owned = [entitlement({ isAcknowledged: false, purchaseToken: 'x' })];
  assert.equal(await iap.owned(), true);
  await settle();
  assert.equal(calls.filter((c) => c.name === 'acknowledgePurchase').length, 0);
  assert.equal(clock.pending(), 0);
});

test('iOS: calls are not queued or shared: each goes to StoreKit the moment it is made', async () => {
  const { iap, calls } = setup();
  const answers = [iap.owned(), iap.owned(), iap.product(), iap.purchase(), iap.restore()];
  assert.deepEqual(
    calls.map((c) => c.name),
    ['getPurchases', 'getPurchases', 'getProduct', 'purchaseProduct', 'restorePurchases'],
    'all five are with the plugin before anything has answered',
  );
  assert.deepEqual((await Promise.all(answers)).slice(2), [{ price: '£2.99' }, 'purchased', true]);
});

test('restore() syncs with the App Store and reports whether the entitlement exists', async () => {
  const none = setup();
  assert.equal(await none.iap.restore(), false);
  assert.deepEqual(none.calls.map((c) => c.name), ['restorePurchases', 'getPurchases']);

  const found = setup();
  found.purchases.owned = [entitlement()];
  assert.equal(await found.iap.restore(), true);
});

test('restore() still checks local entitlements when the sync fails, and never rejects', async () => {
  const cancelled = setup({ restorePurchases: rejecting('userCancelled') });
  cancelled.purchases.owned = [entitlement()];
  assert.equal(await cancelled.iap.restore(), true);

  const broken = setup({ restorePurchases: rejecting('offline'), getPurchases: rejecting('offline') });
  assert.equal(await broken.iap.restore(), false);
});

test('without a product id nothing is available and nothing is called', async () => {
  const calls = [];
  const iap = createIapProvider(
    new Proxy({}, { get: (_, name) => () => calls.push(name) }),
    '',
    { log: quiet },
  );
  assert.equal(iap.available(), false);
  assert.equal(await iap.product(), null);
  assert.equal(await iap.owned(), false);
  assert.equal(await iap.purchase(), 'failed');
  assert.deepEqual(calls, []);
});

// --- Android: Google Play ------------------------------------------------------------------------
//
// The same provider, told it runs on Android, against a fake that answers as the plugin's
// Android source does with a Google Play account behind it (helpers-android.js).

const ACK_BASE = 30_000;
const SWEEP = 5_000;

function android(options = {}) {
  const store = createFakePlayPurchases(options);
  const clock = createFakeClock();
  const state = createFakeAppState();
  const iap = createIapProvider(store, PRODUCT, { os: 'android', onActive: state.onActive, clock, log: quiet });
  return { store, play: store.play, clock, state, iap };
}

test('android: product() resolves the price as Google Play formats it, or null', async () => {
  const { iap, store, play } = android();
  assert.deepEqual(await iap.product(), { price: '£2.99' });
  assert.deepEqual(store.calls[0].opts, { productIdentifier: PRODUCT, productType: 'inapp' });

  play.catalog.clear(); // not created in the Play Console, or not active yet
  assert.equal(await iap.product(), null);
  play.unavailable = true;
  assert.equal(await iap.product(), null);
});

test('android: purchase() buys a one-time product that is acknowledged, not consumed', async () => {
  const { iap, store, play } = android();
  assert.equal(await iap.purchase(), 'purchased');
  assert.deepEqual(store.calls.at(-1).opts, {
    productIdentifier: PRODUCT,
    productType: 'inapp',
    isConsumable: false,
    autoAcknowledgePurchases: true,
  });
  assert.deepEqual(play.purchases.map((p) => [p.productId, p.state, p.acknowledged]), [[PRODUCT, 1, true]]);
  assert.equal(store.count('acknowledgePurchase'), 0, 'the plugin did it as part of the purchase');
  assert.equal(await iap.owned(), true);
});

test('android: purchase() result for every way Google Play can refuse', async () => {
  assert.equal(await android({ sheet: 'cancel' }).iap.purchase(), 'cancelled'); // code USER_CANCELED
  assert.equal(await android({ sheet: 'error' }).iap.purchase(), 'failed'); // code SERVICE_UNAVAILABLE

  const noPlay = android();
  noPlay.play.unavailable = true;
  assert.equal(await noPlay.iap.purchase(), 'failed');

  const unknown = android();
  unknown.play.catalog.clear();
  assert.equal(await unknown.iap.purchase(), 'failed'); // "Product not found"
});

test('android: a pending payment is not a purchase, not an error, and not owned until it clears', async () => {
  const { iap, store, play } = android({ sheet: 'pending' });
  assert.equal(await iap.purchase(), 'cancelled', 'Play has told the player what happens next');
  assert.equal(play.purchases.length, 1, 'Play lists it, as pending');
  assert.equal(await iap.owned(), false);
  assert.equal(await iap.restore(), false);
  assert.equal(store.count('acknowledgePurchase'), 0);

  store.paymentCleared(play.purchases[0].token); // while no purchase call is under way
  assert.equal(await iap.owned(), true);
  await settle();
  assert.equal(play.purchases[0].acknowledged, true, 'and it is acknowledged, or Play would refund it after three days');
});

test('android: buying what the account already owns counts as purchased', async () => {
  const { iap, store, play } = android();
  store.ownedElsewhere(PRODUCT, { acknowledged: false });
  assert.equal(await iap.purchase(), 'purchased'); // code ITEM_ALREADY_OWNED, and Play confirms it
  await settle();
  assert.equal(play.purchases[0].acknowledged, true);

  // Refused as already owned, but Play does not list it (yet): nothing is handed out on that word alone.
  const odd = android();
  odd.store.purchaseProduct = () => Promise.reject(Object.assign(new Error('Purchase is not purchased'), { code: 'ITEM_ALREADY_OWNED' }));
  assert.equal(await odd.iap.purchase(), 'failed');
});

test('android: a purchase whose acknowledgement failed is still purchased, and is acknowledged later', async () => {
  const { iap, store, play, clock } = android();
  play.acknowledgeFails = true; // the connection dropped right after the payment
  assert.equal(await iap.purchase(), 'purchased');
  await settle();
  assert.equal(store.count('acknowledgePurchase'), 1, 'tried again at once');
  assert.equal(play.purchases[0].acknowledged, false);

  await clock.advance(ACK_BASE - 1);
  assert.equal(store.count('acknowledgePurchase'), 1);
  await clock.advance(1);
  assert.equal(store.count('acknowledgePurchase'), 2, 'and again after the first delay');
  await clock.advance(2 * ACK_BASE - 1);
  assert.equal(store.count('acknowledgePurchase'), 2, 'the delay doubles');

  play.acknowledgeFails = false;
  await clock.advance(1);
  assert.equal(store.count('acknowledgePurchase'), 3);
  assert.equal(play.purchases[0].acknowledged, true);

  await clock.advance(60 * 60_000);
  assert.equal(store.count('acknowledgePurchase'), 3, 'once Play has it, nothing more is sent');
});

test('android: coming back to the foreground retries a failed acknowledgement at once', async () => {
  const { iap, store, play, state, clock } = android();
  play.acknowledgeFails = true;
  await iap.purchase();
  await settle();
  play.acknowledgeFails = false;
  state.fire(false);
  await settle();
  assert.equal(play.purchases[0].acknowledged, false, 'leaving does nothing');
  state.fire(true);
  await settle();
  assert.equal(play.purchases[0].acknowledged, true);
  await clock.advance(60 * 60_000);
  assert.equal(store.count('acknowledgePurchase'), 2, 'the timer that was waiting does not send another');
});

test('android: an acknowledgement is not repeated blindly: Play is asked how things stand first', async () => {
  // The try failed as far as the app could tell, but Play has recorded it.
  const lostAnswer = android();
  lostAnswer.play.acknowledgeFails = true;
  await lostAnswer.iap.purchase();
  await settle();
  lostAnswer.play.purchases[0].acknowledged = true;
  await lostAnswer.clock.advance(60 * 60_000);
  assert.equal(lostAnswer.store.count('acknowledgePurchase'), 1);

  // The purchase is gone (refunded).
  const refunded = android();
  refunded.play.acknowledgeFails = true;
  await refunded.iap.purchase();
  await settle();
  refunded.store.refunded(refunded.play.purchases[0].token);
  await refunded.clock.advance(60 * 60_000);
  assert.equal(refunded.store.count('acknowledgePurchase'), 1);

  // Play cannot even be asked: keep trying with the token in hand, at the growing delay.
  const offline = android();
  offline.play.acknowledgeFails = true;
  await offline.iap.purchase();
  await settle();
  offline.play.unavailable = true;
  await offline.clock.advance(ACK_BASE);
  assert.equal(offline.store.count('acknowledgePurchase'), 2);
  offline.play.unavailable = false;
  offline.play.acknowledgeFails = false;
  await offline.clock.advance(2 * ACK_BASE);
  assert.equal(offline.play.purchases[0].acknowledged, true);
});

test('android: an unacknowledged purchase is found a few seconds after the page starts, without the game asking', async () => {
  // The game has Remove Ads in its save and never calls owned() again.
  const { store, play, clock } = android();
  store.ownedElsewhere(PRODUCT, { acknowledged: false });
  await clock.advance(SWEEP - 1);
  assert.equal(store.calls.length, 0);
  await clock.advance(1);
  assert.equal(store.count('getPurchases'), 1);
  assert.equal(play.purchases[0].acknowledged, true);
  assert.equal(clock.pending(), 0);
});

test('android: that look is skipped when the game has asked owned() meanwhile', async () => {
  const { iap, store, clock } = android();
  assert.equal(await iap.owned(), false);
  await clock.advance(SWEEP);
  assert.equal(store.count('getPurchases'), 1);

  // ... but not when the game's own look failed.
  const failed = android();
  failed.play.unavailable = true;
  assert.equal(await failed.iap.owned(), false);
  failed.play.unavailable = false;
  await failed.clock.advance(SWEEP);
  assert.equal(failed.store.count('getPurchases'), 2);
});

// One lookup at a time. The plugin ends the connection of an unanswered getPurchases or
// getProduct as soon as the next call of any kind arrives, and that lookup then never
// answers (the fake does the same: helpers-android.js). Nothing the bridge does may cut one off.

test('android: the bridge\'s own look, falling due while the game\'s owned() is on its way, joins it', async () => {
  // A reinstall: Play has the paid, acknowledged purchase on record, the game's save has nothing.
  const { iap, store, play, clock } = android({ holdLookups: true });
  store.ownedElsewhere(PRODUCT);
  await clock.advance(SWEEP - 200);
  const game = iap.owned(); // the game's start-up check, a moment before the bridge's own look
  await settle();
  assert.equal(store.count('getPurchases'), 1);

  await clock.advance(200);
  assert.equal(store.count('getPurchases'), 1, 'no second lookup: it would end the first one\'s connection');
  assert.equal(play.lookupsCutOff, 0);

  store.answerLookups(); // Google Play answers, a little late
  assert.equal(await game, true, 'the player who reinstalled gets Remove Ads back at once');
  await clock.advance(60_000);
  assert.equal(store.count('getPurchases'), 1);
  assert.equal(clock.pending(), 0);
});

test('android: everyone who asks owned() while a lookup is on its way gets that lookup\'s answer; later callers ask again', async () => {
  const { iap, store, play } = android({ holdLookups: true });
  store.ownedElsewhere(PRODUCT, { acknowledged: false });
  const answers = [iap.owned(), iap.owned()];
  await settle();
  assert.deepEqual(store.calls.map((c) => c.name), ['getPurchases']);
  store.answerLookups();
  assert.deepEqual(await Promise.all(answers), [true, true]);
  await settle();
  assert.equal(store.count('acknowledgePurchase'), 1, 'two askers, one acknowledgement');
  assert.equal(play.purchases[0].acknowledged, true);
  assert.equal(play.lookupsCutOff, 0);

  const later = iap.owned();
  await settle();
  assert.equal(store.count('getPurchases'), 2, 'an answer is not kept: the next question goes to Play again');
  store.answerLookups();
  assert.equal(await later, true);
});

test('android: a restore waits for a lookup on its way, and takes a look of its own afterwards', async () => {
  const { iap, store, play } = android({ holdLookups: true });
  store.ownedElsewhere(PRODUCT);
  const owned = iap.owned();
  const restored = iap.restore();
  await settle();
  assert.deepEqual(store.calls.map((c) => c.name), ['getPurchases'], 'the restore would end the lookup\'s connection');
  store.answerLookups();
  assert.equal(await owned, true);
  await settle();
  // Not the answer from before the restore: what Play says after it.
  assert.deepEqual(store.calls.map((c) => c.name), ['getPurchases', 'restorePurchases', 'getPurchases']);
  store.answerLookups();
  assert.equal(await restored, true);
  assert.equal(play.lookupsCutOff, 0);
});

test('android: a price lookup and an entitlement lookup made together go to Play one after the other', async () => {
  const { iap, store, play } = android({ holdLookups: true });
  store.ownedElsewhere(PRODUCT);
  const price = iap.product();
  const owned = iap.owned();
  await settle();
  assert.deepEqual(store.calls.map((c) => c.name), ['getProduct'], 'the second waits for the first to answer');
  store.answerLookups();
  await settle();
  assert.deepEqual(store.calls.map((c) => c.name), ['getProduct', 'getPurchases']);
  store.answerLookups();
  assert.deepEqual(await price, { price: '£2.99' });
  assert.equal(await owned, true);
  assert.equal(play.lookupsCutOff, 0);
});

test('android: a lookup that never answers holds the next call only until its own time limit', async () => {
  const { iap, store, play, clock } = android({ holdLookups: true });
  store.ownedElsewhere(PRODUCT);
  const price = iap.product(); // Google Play never answers this one
  const owned = iap.owned();
  await clock.advance(14_999);
  assert.deepEqual(store.calls.map((c) => c.name), ['getProduct']);
  await clock.advance(1);
  assert.equal(await price, null, 'given up on');
  assert.deepEqual(store.calls.map((c) => c.name), ['getProduct', 'getPurchases'], 'and the line is free again');
  assert.equal(play.lookupsCutOff, 1, 'only the lookup that was given up on');
  store.answerLookups();
  assert.equal(await owned, true);
  // The time limit of the second lookup started when it was sent, not when it was asked for.
  await clock.advance(60_000);
  assert.equal(clock.pending(), 0);
});

test('android: a purchase waits for a lookup on its way, and does not hold up the calls after it', async () => {
  const { iap, store, play } = android({ holdLookups: true });
  const owned = iap.owned();
  const bought = iap.purchase();
  await settle();
  assert.deepEqual(store.calls.map((c) => c.name), ['getPurchases'], 'the purchase would end the lookup\'s connection');
  store.answerLookups();
  assert.equal(await owned, false);
  assert.equal(await bought, 'purchased');
  assert.equal(play.lookupsCutOff, 0);

  // Play's purchase sheet can stay open for minutes. Lookups made meanwhile go out at once:
  // the plugin keeps the connection of an open sheet alive itself.
  const slow = android({ holdLookups: true });
  let sheetCloses;
  slow.store.purchaseProduct = (opts) => {
    slow.store.calls.push({ name: 'purchaseProduct', opts });
    return new Promise((resolve) => {
      sheetCloses = () => resolve({ transactionId: 't', productIdentifier: PRODUCT, purchaseToken: 't', isAcknowledged: true });
    });
  };
  const buying = slow.iap.purchase();
  const price = slow.iap.product();
  await settle();
  assert.deepEqual(slow.store.calls.map((c) => c.name), ['purchaseProduct', 'getProduct'], 'in the order they were made');
  slow.store.answerLookups();
  assert.deepEqual(await price, { price: '£2.99' });
  assert.equal(await peek(buying), 'pending');
  sheetCloses();
  assert.equal(await buying, 'purchased');
});

test('android: whatever the game and the bridge ask at the same moment, no lookup is ever cut off', async () => {
  const { iap, store, play, clock, state } = android();
  store.ownedElsewhere(PRODUCT, { acknowledged: false });
  play.acknowledgeFails = true; // so that retries and re-checks join in
  const asked = [iap.product(), iap.owned(), iap.restore(), iap.owned(), iap.product(), iap.purchase(), iap.owned()];
  state.fire(true); // the app comes to the front in the middle of it
  await clock.advance(SWEEP);
  play.acknowledgeFails = false;
  state.fire(false);
  state.fire(true);
  const more = [iap.product(), iap.owned(), iap.restore()];
  await clock.advance(10 * 60_000);
  assert.deepEqual(await Promise.all(asked), [{ price: '£2.99' }, true, true, true, { price: '£2.99' }, 'purchased', true]);
  assert.deepEqual(await Promise.all(more), [{ price: '£2.99' }, true, true]);
  assert.equal(play.lookupsCutOff, 0);
  assert.equal(play.purchases.length, 1);
  assert.equal(play.purchases[0].acknowledged, true);
});

test('android: restore() has Play acknowledge what is unfinished and reports whether Remove Ads is owned', async () => {
  const none = android();
  assert.equal(await none.iap.restore(), false);
  assert.deepEqual(none.store.calls.map((c) => c.name), ['restorePurchases', 'getPurchases']);

  const found = android();
  found.store.ownedElsewhere(PRODUCT, { acknowledged: false });
  assert.equal(await found.iap.restore(), true);
  assert.equal(found.play.purchases[0].acknowledged, true);
  assert.equal(found.store.count('acknowledgePurchase'), 0, 'the plugin did it; nothing was left for the bridge');

  const other = android();
  other.store.ownedElsewhere('something_else');
  assert.equal(await other.iap.restore(), false);
});

test('android: nothing rejects when Google Play cannot be reached', async () => {
  const { iap, play, clock } = android();
  play.unavailable = true;
  assert.equal(iap.available(), true);
  assert.equal(await iap.product(), null);
  assert.equal(await iap.owned(), false);
  assert.equal(await iap.purchase(), 'failed');
  assert.equal(await iap.restore(), false);
  await clock.advance(60_000);
});

test('android: without a product id nothing is called, started or timed', async () => {
  const calls = [];
  const clock = createFakeClock();
  const iap = createIapProvider(new Proxy({}, { get: (_, name) => () => calls.push(name) }), '', { os: 'android', clock, log: quiet });
  assert.equal(iap.available(), false);
  assert.equal(await iap.purchase(), 'failed');
  await clock.advance(60_000);
  assert.deepEqual(calls, []);
});
