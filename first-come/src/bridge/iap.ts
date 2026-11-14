import type { NativePurchasesPlugin, PURCHASE_TYPE } from '@capgo/native-purchases';
import type { IapProvider, PurchaseResult } from './types.ts';
import { attempt, backoffDelay, type Clock, enumValue, errorText, type Logger, noop, systemClock, withTimeout } from './util.ts';

// platform.iap on native: the one non-consumable "Remove Ads" product, through
// @capgo/native-purchases (StoreKit 2 on iOS, Google Play Billing on Android, no server
// involved).
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
//
// What it does on Android, read from the same version (android/src/main/java/ee/forgr/
// nativepurchases/NativePurchasesPlugin.java, PurchaseActionDecider.java,
// ProductPayloadMapper.java; Play Billing Library 9.1.0). Every call opens its own
// connection to Google Play and closes it again, and before it opens its own it ENDS the
// connection of the call before, unless that one has a purchase sheet open or an
// acknowledgement on its way (initBillingClient -> closeBillingClientLocked). A lookup
// (getProduct, getPurchases) whose connection is ended like that never answers. Hence the
// "one lookup at a time" rule in createIapProvider below.
//  getProduct       queryProductDetails; priceString is Play's formattedPrice of the one-time
//                   purchase offer, in the player's currency. Rejects "Product not found".
//  purchaseProduct  productType 'inapp' is a one-time product. `quantity` is ignored (Play's
//                   own sheet owns it). With isConsumable false and autoAcknowledgePurchases
//                   true, which are the defaults and are sent explicitly below, a finished
//                   purchase is ACKNOWLEDGED before the call resolves, and the transaction it
//                   resolves with says whether that worked (isAcknowledged). Google refunds a
//                   purchase that is not acknowledged within three days, and the call
//                   resolves even when the acknowledgement failed, so see acknowledge().
//                   It rejects with the message "Purchase is not purchased" and the reason
//                   in the error CODE: USER_CANCELED when the sheet is closed,
//                   ITEM_ALREADY_OWNED when Play says the account has it already,
//                   SERVICE_UNAVAILABLE, BILLING_UNAVAILABLE and so on. A payment that is
//                   not complete yet (cash, a slow card, a parent's approval) rejects with
//                   the message "Purchase is pending" and no code.
//  restorePurchases looks up the account's purchases and acknowledges any that is paid for
//                   but not acknowledged. It resolves as soon as that work is started and
//                   returns nothing; the getPurchases behind it waits for the work to end.
//  getPurchases     queryPurchases from Play's on-device cache (works offline). Each entry
//                   has purchaseState "1" (paid), "2" (pending) or "0", isAcknowledged and
//                   purchaseToken. A PENDING purchase is in the list but is not owned yet.
//                   A refunded one drops out of the list. onlyCurrentEntitlements is not
//                   read on Android. A failed lookup rejects; it never looks like "nothing".

export type PurchasesLike = Pick<
  NativePurchasesPlugin,
  'getProduct' | 'getPurchases' | 'purchaseProduct' | 'restorePurchases' | 'acknowledgePurchase'
>;

const INAPP = enumValue<PURCHASE_TYPE.INAPP>('inapp');

/** Purchase.PurchaseState.PURCHASED, as the Android side prints it (String.valueOf of the int). */
const PLAY_PURCHASED = '1';

export interface IapOptions {
  /** Capacitor.getPlatform(). Only 'android' has purchases to acknowledge. */
  os?: string;
  /** Subscribe to foreground / background changes (for retrying an acknowledgement). */
  onActive?: (cb: (active: boolean) => void) => void;
  clock?: Clock;
  log?: Logger;
  /** Give up on a store lookup (price, entitlements) after this long. */
  lookupTimeoutMs?: number;
  /** Android: first retry delay after a failed acknowledgement; doubles up to the cap. */
  acknowledgeRetryBaseMs?: number;
  acknowledgeRetryCapMs?: number;
  /**
   * Android: this long after the page has started, look for a paid but unacknowledged
   * purchase, unless the game has asked owned() by then (which does the same).
   */
  sweepDelayMs?: number;
}

export function createIapProvider(purchases: PurchasesLike, productId: string, options: IapOptions = {}): IapProvider {
  const android = options.os === 'android';
  const clock = options.clock ?? systemClock;
  const log = options.log ?? noop;
  const lookupTimeoutMs = options.lookupTimeoutMs ?? 15_000;
  const acknowledgeRetryBaseMs = options.acknowledgeRetryBaseMs ?? 30_000;
  const acknowledgeRetryCapMs = options.acknowledgeRetryCapMs ?? 10 * 60_000;
  const sweepDelayMs = options.sweepDelayMs ?? 5_000;
  let buying: Promise<PurchaseResult> | null = null;
  /** Since the page started, the store has said what the account holds: a lookup worked, or a purchase was made. */
  let looked = false;

  // --- one lookup at a time (Android) ----------------------------------------------------
  //
  // On Android a plugin call that arrives while a lookup is unanswered ends that lookup's
  // connection to Google Play (see the top of this file), and the lookup then never answers:
  // the bridge would report "not owned" or "no price" when its time limit runs out, although
  // Play had the answer. It is easily done: the game asks owned() when it starts, the
  // bridge takes its own look a few seconds later, the price is asked for when the shop
  // opens, and an acknowledgement is retried whenever the app comes to the front.
  //
  // So on Android every call waits until no lookup is on its way. `line` settles when the
  // calls made so far have been sent and the lookups among them have answered or run out of
  // time. A lookup holds the line until then. A purchase, a restore and an acknowledgement
  // only take their turn and let the next call follow at once: the plugin keeps their
  // connections open itself, and a purchase sheet can stay up for minutes. The plugin works
  // through its calls in the order they are made, so sending in order is enough.
  //
  // On iPhone there are no connections to trip over: every call goes out at once, as before.

  let line: Promise<void> = Promise.resolve();

  /** A call that only reads from the store, with the time limit for those. */
  function lookup<T>(label: string, call: () => T | Promise<T>): Promise<T> {
    const send = (): Promise<T> => withTimeout(clock, attempt(call), lookupTimeoutMs, label);
    if (!android) return send();
    const answer = line.then(send);
    line = answer.then(noop, noop);
    return answer;
  }

  /** Any other call to the store. It has no time limit: a purchase lasts as long as the player takes. */
  function order<T>(call: () => T | Promise<T>): Promise<T> {
    if (!android) return attempt(call);
    const answer = line.then(() => attempt(call));
    line = line.then(noop); // settles just after the call above has been made
    return answer;
  }

  // --- acknowledging (Android) ---------------------------------------------------------
  //
  // Google Play refunds a purchase that the app has not acknowledged within three days.
  // The plugin acknowledges as part of purchaseProduct, but that can fail (the connection
  // drops right after the payment), and a purchase can also complete while no purchase call
  // is under way: a pending payment that clears later, a promo code redeemed in the Play
  // Store. So every place that sees a paid, unacknowledged purchase of the product hands
  // its token to acknowledge(), which keeps at it until Play has it on record: at once,
  // then with a growing delay, and whenever the app comes back to the foreground. A later
  // start of the page picks it up again through the sweep at the bottom of this function.

  let unacknowledged: string | null = null;
  let acknowledging = false;
  let ackFailures = 0;
  let ackTimer: unknown = null;

  function acknowledge(token: unknown): void {
    if (!android || typeof token !== 'string' || !token) return;
    unacknowledged = token;
    tryAcknowledge();
  }

  function tryAcknowledge(): void {
    const token = unacknowledged;
    if (token === null || acknowledging) return;
    if (ackTimer !== null) {
      clock.clearTimeout(ackTimer);
      ackTimer = null;
    }
    acknowledging = true;
    order(() => purchases.acknowledgePurchase({ purchaseToken: token }))
      .then(
        () => {
          ackFailures = 0;
          if (unacknowledged === token) unacknowledged = null;
        },
        (error) => {
          ackFailures++;
          const delay = backoffDelay(ackFailures, acknowledgeRetryBaseMs, acknowledgeRetryCapMs);
          log(`The purchase could not be acknowledged (${ackFailures} in a row), next look in ${delay} ms`, error);
          ackTimer = clock.setTimeout(() => {
            ackTimer = null;
            void recheck();
          }, delay);
        },
      )
      .then(() => {
        acknowledging = false;
        if (unacknowledged !== null && unacknowledged !== token) tryAcknowledge(); // another purchase turned up meanwhile
      });
  }

  /**
   * Before the acknowledgement is tried again, ask Play how things stand: an earlier try
   * whose answer was lost may have gone through, or the purchase may be gone (refunded).
   * Repeating the call blindly would then fail for ever.
   */
  async function recheck(): Promise<void> {
    if (unacknowledged === null || acknowledging) return;
    const mine = await find();
    if (mine === undefined) tryAcknowledge(); // Play could not be asked: the token in hand is still the best there is
    else if (!mine || mine.isAcknowledged !== false) unacknowledged = null;
    else acknowledge(mine.purchaseToken);
  }

  // --- entitlement -----------------------------------------------------------------------

  type Entry = Awaited<ReturnType<PurchasesLike['getPurchases']>>['purchases'][number];

  /** Android: the entitlement lookup that is on its way, shared by everyone who asks meanwhile. */
  let finding: Promise<Entry | null | undefined> | null = null;

  /**
   * The purchase that makes Remove Ads owned; null when there is none; undefined when the
   * store could not be asked.
   *
   * On Android, callers that ask while a lookup is on its way get that lookup's answer: a
   * second getPurchases would only have to wait for the first, and say the same.
   */
  function find(): Promise<Entry | null | undefined> {
    if (finding) return finding;
    const mine: Promise<Entry | null | undefined> = lookup('getPurchases', () =>
      purchases.getPurchases({ productType: INAPP, onlyCurrentEntitlements: true }),
    ).then(
      (result) => {
        if (finding === mine) finding = null;
        try {
          const list = result && Array.isArray(result.purchases) ? result.purchases : [];
          // iOS: not refunded. Android: paid for; a pending payment is listed but is not owned.
          // purchaseState only exists on Android, revocationDate only on iOS.
          const entry =
            list.find(
              (t) =>
                !!t &&
                t.productIdentifier === productId &&
                !t.revocationDate &&
                (t.purchaseState === undefined || t.purchaseState === null || t.purchaseState === PLAY_PURCHASED),
            ) ?? null;
          looked = true;
          return entry;
        } catch (error) {
          log('Entitlements could not be read', error); // an answer in a shape nobody expected
          return undefined;
        }
      },
      (error) => {
        if (finding === mine) finding = null;
        log('Entitlements could not be read', error);
        return undefined;
      },
    );
    if (android) finding = mine;
    return mine;
  }

  // false means "not among the current entitlements" AND "could not find out" (plugin error,
  // timeout): the contract gives owned() no third answer, and nothing in the bridge rejects
  // into the game. So the game may act on true, never on false. Taking Remove Ads away
  // again after a refund needs a way to tell the two apart first.
  async function owned(): Promise<boolean> {
    if (!productId) return false;
    const mine = await find();
    if (!mine) return false;
    if (mine.isAcknowledged === false) acknowledge(mine.purchaseToken);
    return true;
  }

  async function buy(): Promise<PurchaseResult> {
    try {
      const transaction = await order(() =>
        purchases.purchaseProduct(
          android
            ? // A one-time product that is kept: acknowledge it, never consume it. Both are the
              // plugin's defaults; they are spelled out because a refund hangs on them.
              { productIdentifier: productId, productType: INAPP, isConsumable: false, autoAcknowledgePurchases: true }
            : { productIdentifier: productId, productType: INAPP, quantity: 1 },
        ),
      );
      looked = true;
      // Android: bought, but the acknowledgement did not go through. Keep at it.
      if (transaction && transaction.isAcknowledged === false) acknowledge(transaction.purchaseToken);
      return 'purchased';
    } catch (error) {
      // iOS puts the reason in the message, Android in the error code.
      const code = error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : '';
      const reason = `${errorText(error)} ${code}`;
      // A pending payment (iOS: Ask to Buy, bank approval; Android: cash, a slow card, a
      // parent's approval) is neither a failure nor a purchase yet. The store has already
      // told the player what happens next, so report it like a cancellation: no error
      // message. If it goes through later, owned() finds it.
      if (/cancel/i.test(reason) || /pending/i.test(reason)) return 'cancelled';
      // Android: Play refused because the account owns the product already (bought on another
      // phone, or a purchase this install never heard the end of). That is what the player
      // wanted, provided it is true.
      if (/ITEM_ALREADY_OWNED/.test(code) && (await owned())) return 'purchased';
      log('Purchase failed', error);
      return 'failed';
    }
  }

  if (android && productId) {
    try {
      options.onActive?.((active) => {
        if (active) void recheck();
      });
    } catch (error) {
      log('Could not subscribe to app state changes', error);
    }
    // The game only asks owned() while Remove Ads is not recorded in its save. A purchase it
    // has recorded but Play has not seen acknowledged would never be looked at again. If the
    // game's own owned() is still on its way at that moment, this joins it (see find()).
    clock.setTimeout(() => {
      if (!looked) void owned();
    }, sweepDelayMs);
  }

  return {
    available: () => !!productId,

    async product() {
      if (!productId) return null;
      try {
        const result = await lookup('getProduct', () => purchases.getProduct({ productIdentifier: productId, productType: INAPP }));
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
      // A second tap while the store's sheet is up joins the purchase already under way.
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
        // iOS: AppStore.sync(). Android: acknowledges what is paid for and unacknowledged.
        await order(() => purchases.restorePurchases());
      } catch (error) {
        // The sync failed or was cancelled; what this device already knows still counts.
        log('The store could not be asked to restore purchases', error);
      }
      return owned();
    },
  };
}
