// platform.iap: the single non-consumable "Remove Ads" product.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIapProvider } from '../src/bridge/iap.ts';
import { createFakeClock, peek, quiet } from './helpers.js';

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
