import type { NativePurchasesPlugin, PURCHASE_TYPE } from '@capgo/native-purchases';
import type { IapProvider, PurchaseResult } from './types.ts';
import { attempt, type Clock, enumValue, errorText, type Logger, noop, systemClock, withTimeout } from './util.ts';

// platform.iap on native: the one non-consumable "Remove Ads" product, through
// @capgo/native-purchases (StoreKit 2 on iOS, no server involved).
//
// What the plugin does on iOS, read from 8.9.16 (ios/Sources/NativePurchasesPlugin):
//  getProduct       Product.products(for:); priceString is StoreKit's displayPrice, already
//                   formatted for the player's storefront. Rejects when the product is unknown.
//  purchaseProduct  product.purchase(). Resolves the transaction only for a purchase StoreKit
//                   verified, and finishes it. Rejects "User cancelled" when the sheet is
//                   closed, "Transaction pending" for Ask to Buy / bank approval, and the
//                   StoreKit error text otherwise.
//  restorePurchases AppStore.sync(). Resolves nothing; rejects if the player backs out of
//                   the sign-in.
//  getPurchases     with onlyCurrentEntitlements it reads Transaction.currentEntitlements:
//                   verified, unrefunded purchases of the signed-in Apple ID. Works offline.

export type PurchasesLike = Pick<NativePurchasesPlugin, 'getProduct' | 'getPurchases' | 'purchaseProduct' | 'restorePurchases'>;

const INAPP = enumValue<PURCHASE_TYPE.INAPP>('inapp');

export interface IapOptions {
  clock?: Clock;
  log?: Logger;
  /** Give up on a store lookup (price, entitlements) after this long. */
  lookupTimeoutMs?: number;
}

export function createIapProvider(purchases: PurchasesLike, productId: string, options: IapOptions = {}): IapProvider {
  const clock = options.clock ?? systemClock;
  const log = options.log ?? noop;
  const lookupTimeoutMs = options.lookupTimeoutMs ?? 15_000;
  let buying: Promise<PurchaseResult> | null = null;

  // false means "not among the current entitlements" AND "could not find out" (plugin error,
  // timeout): the contract gives owned() no third answer, and nothing in the bridge rejects
  // into the game. So the game may act on true, never on false. Taking Remove Ads away
  // again after a refund needs a way to tell the two apart first.
  async function owned(): Promise<boolean> {
    if (!productId) return false;
    try {
      const result = await withTimeout(
        clock,
        attempt(() => purchases.getPurchases({ productType: INAPP, onlyCurrentEntitlements: true })),
        lookupTimeoutMs,
        'getPurchases',
      );
      const list = result && Array.isArray(result.purchases) ? result.purchases : [];
      return list.some((t) => !!t && t.productIdentifier === productId && !t.revocationDate);
    } catch (error) {
      log('Entitlements could not be read', error);
      return false;
    }
  }

  async function buy(): Promise<PurchaseResult> {
    try {
      await attempt(() => purchases.purchaseProduct({ productIdentifier: productId, productType: INAPP, quantity: 1 }));
      return 'purchased';
    } catch (error) {
      const text = errorText(error);
      // "Transaction pending" (Ask to Buy, bank approval) is neither a failure nor a purchase
      // yet. iOS has already told the player what happens next, so report it like a
      // cancellation: no error message. If it is approved later, owned() finds it.
      if (/cancel/i.test(text) || /pending/i.test(text)) return 'cancelled';
      log('Purchase failed', error);
      return 'failed';
    }
  }

  return {
    available: () => !!productId,

    async product() {
      if (!productId) return null;
      try {
        const result = await withTimeout(
          clock,
          attempt(() => purchases.getProduct({ productIdentifier: productId, productType: INAPP })),
          lookupTimeoutMs,
          'getProduct',
        );
        const price = result && result.product && typeof result.product.priceString === 'string' ? result.product.priceString.trim() : '';
        return price ? { price } : null;
      } catch (error) {
        log('The product could not be loaded', error);
        return null;
      }
    },

    owned,

    purchase() {
      if (!productId) return Promise.resolve<PurchaseResult>('failed');
      // A second tap while the App Store sheet is up joins the purchase already under way.
      if (!buying) {
        const current: Promise<PurchaseResult> = buy().then((result) => {
          if (buying === current) buying = null;
          return result;
        });
        buying = current;
      }
      return buying;
    },

    async restore() {
      try {
        await attempt(() => purchases.restorePurchases());
      } catch (error) {
        // The sync failed or was cancelled; what this device already knows still counts.
        log('AppStore sync failed during restore', error);
      }
      return owned();
    },
  };
}
