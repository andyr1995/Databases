// What the bridge and its Android test doubles take for granted about the plugins, read from
// the plugins' own Java in node_modules.
//
// helpers-android.js imitates that Java, and helpers-android.test.js checks the imitation
// against itself: an update of a plugin that changed the behaviour would leave every test
// green and the bridge wrong. So the behaviours the bridge is built around are pinned here to
// the source text. When one of these tests fails after `npm update`, read the plugin's new
// source at that place, then change the bridge and the fake (or this pin) to match it.
//
// Each pin names the place in src/bridge or test/ that depends on it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (...parts) => readFileSync(path.join(root, 'node_modules', ...parts), 'utf8');

/** The body of the Java method whose declaration matches `signature`: from its `{` to the matching `}`. */
function methodBody(java, signature) {
  const found = signature.exec(java);
  assert.ok(found, `no method matching ${signature}`);
  const open = java.indexOf('{', found.index + found[0].length - 1);
  let depth = 0;
  for (let i = open; i < java.length; i += 1) {
    if (java[i] === '{') depth += 1;
    else if (java[i] === '}' && (depth -= 1) === 0) return java.slice(open, i + 1);
  }
  assert.fail(`the method matching ${signature} never closes`);
}

/** Java without comments and with white space collapsed, so that reformatting alone does not fail a pin. */
const squeezed = (java) =>
  java
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// --- @capgo/native-purchases: connections to Google Play ---------------------------------------
// src/bridge/iap.ts ("one lookup at a time"), createFakePlayPurchases in helpers-android.js.

const purchases = source('@capgo', 'native-purchases', 'android', 'src', 'main', 'java', 'ee', 'forgr', 'nativepurchases', 'NativePurchasesPlugin.java');

test('purchases plugin: every call that needs Google Play first ends the connection of the call before it', () => {
  // All calls run one after the other on one thread, each through withBillingClient ...
  assert.match(squeezed(purchases), /billingExecutor = Executors\.newSingleThreadExecutor\(/);
  const withClient = squeezed(methodBody(purchases, /private void withBillingClient\(PluginCall call, BillingTask task\) \{/));
  assert.match(withClient, /billingExecutor\.execute\(\(\) -> \{ try \{ initBillingClient\(call\); task\.run\(\);/);
  // ... which opens a connection of its own after closing the one that is there ...
  const init = squeezed(methodBody(purchases, /void initBillingClient\(PluginCall purchaseCall\) \{/));
  assert.match(init, /synchronized \(billingClientLock\) \{ awaitPendingFinishesLocked\(\); closeBillingClientLocked\(\); \}/);
  // ... and closing means ending it, unless a purchase sheet is open on it or an acknowledgement is in flight.
  const close = squeezed(methodBody(purchases, /private void closeBillingClientLocked\(\) \{/));
  assert.match(
    close,
    /if \(billingClient != null && \(pendingBillingFlows\.containsKey\(billingClient\) \|\| pendingFinishes\.containsKey\(billingClient\)\)\) \{[^}]*billingClient = null; \} else if \(billingClient != null\) \{[^}]*billingClient\.endConnection\(\);/,
  );
});

test('purchases plugin: a lookup is not protected from that; a purchase, a restore and an acknowledgement are', () => {
  // getPurchases and getProduct register neither a billing flow nor a pending finish, so the
  // next call ends their connection and they never answer: the bridge must not overlap them.
  const getPurchases = squeezed(methodBody(purchases, /public void getPurchases\(PluginCall call\) \{/));
  assert.match(getPurchases, /withBillingClient\(call, \(\) -> \{/);
  assert.match(getPurchases, /billingClient\.queryPurchasesAsync\(/);
  assert.doesNotMatch(getPurchases, /beginPendingBillingFlow|beginFinishingPurchase/);
  const getProduct = squeezed(methodBody(purchases, /private void querySingleProductDetails\(String productIdentifier, String productType, PluginCall call\) \{/));
  assert.match(getProduct, /withBillingClient\(call, \(\) -> \{/);
  assert.match(getProduct, /billingClient\.queryProductDetailsAsync\(/);
  assert.doesNotMatch(getProduct, /beginPendingBillingFlow|beginFinishingPurchase/);
  assert.match(squeezed(methodBody(purchases, /public void getProduct\(PluginCall call\) \{/)), /querySingleProductDetails\(productIdentifier, productType, call\);/);

  // A purchase marks its connection before anything else can run, which is why the bridge
  // lets later calls follow a purchase at once.
  const purchase = squeezed(methodBody(purchases, /public void purchaseProduct\(PluginCall call\) \{/));
  assert.match(purchase, /withBillingClient\(call, \(\) -> \{ final BillingClient purchaseClient = billingClient; if \(!beginPendingBillingFlow\(purchaseClient\)\) \{/);
  // So do an acknowledgement and a restore.
  assert.match(squeezed(methodBody(purchases, /void acknowledgeWithClient\(PluginCall call, BillingClient client, String purchaseToken\) \{/)), /if \(!beginFinishingPurchase\(client, onAbandon\)\) \{/);
  assert.match(squeezed(methodBody(purchases, /boolean processUnfinishedPurchases\(BillingClient client\) \{/)), /if \(!beginFinishingPurchase\(client\)\) \{/);
  assert.match(squeezed(methodBody(purchases, /void restoreWithClient\(PluginCall call, BillingClient client\) \{/)), /if \(!processUnfinishedPurchases\(client\)\) \{[^}]*\} call\.resolve\(\);/);
});

test('purchases plugin: what a purchase is asked with and what an entry of getPurchases says', () => {
  // src/bridge/iap.ts sends isConsumable false and autoAcknowledgePurchases true, and reads
  // purchaseState "1", isAcknowledged and purchaseToken.
  const purchase = squeezed(methodBody(purchases, /public void purchaseProduct\(PluginCall call\) \{/));
  assert.match(purchase, /boolean isConsumable = call\.getBoolean\("isConsumable", false\);/);
  assert.match(purchase, /boolean autoAcknowledgePurchases = call\.getBoolean\("autoAcknowledgePurchases", true\);/);
  const entry = squeezed(methodBody(purchases, /private JSObject buildPurchaseTransactionObject\(Purchase purchase, String productType\) \{/));
  assert.match(entry, /purchaseData\.put\("purchaseToken", purchase\.getPurchaseToken\(\)\);/);
  assert.match(entry, /purchaseData\.put\("isAcknowledged", purchase\.isAcknowledged\(\)\);/);
  assert.match(entry, /purchaseData\.put\("purchaseState", String\.valueOf\(purchase\.getPurchaseState\(\)\)\);/);
  assert.match(squeezed(purchases), /case BillingClient\.BillingResponseCode\.ITEM_ALREADY_OWNED: return "ITEM_ALREADY_OWNED";/);
  assert.match(squeezed(purchases), /case BillingClient\.BillingResponseCode\.USER_CANCELED: return "USER_CANCELED";/);
});

// --- @capacitor-community/admob: the banner ----------------------------------------------------
// src/bridge/banner.ts (its "Order" and "where it sits" notes), createFakeAndroidAdMob.

const banner = source('@capacitor-community', 'admob', 'android', 'src', 'main', 'java', 'com', 'getcapacitor', 'community', 'admob', 'banner', 'BannerExecutor.java');

test('admob plugin: showBanner never answers while the plugin already holds a banner view', () => {
  const show = squeezed(methodBody(banner, /public void showBanner\(final PluginCall call, boolean systemBarsHandlesInsets\) \{/));
  // The early way out neither resolves nor rejects the call ...
  assert.match(show, /if \(mAdView != null\) \{ updateExistingAdView\(adOptions\); return; \}/);
  // ... and the method it hands over to has no call to answer.
  assert.match(squeezed(banner), /private void updateExistingAdView\(AdOptions adOptions\) \{/);
  assert.doesNotMatch(methodBody(banner, /private void updateExistingAdView\(AdOptions adOptions\) \{/), /call\./);
  // A new banner is answered straight after the view has been handed to the UI thread.
  assert.match(show, /createNewAdView\(adOptions\); call\.resolve\(\); \} catch \(Exception ex\) \{ call\.reject\(/);
});

test('admob plugin: removeBanner and resumeBanner answer before the UI thread has done the work', () => {
  const remove = squeezed(methodBody(banner, /public void removeBanner\(final PluginCall call\) \{/));
  // The removal is posted to the UI thread; the answer is given outside that task, at once.
  assert.match(remove, /try \{ if \(mAdView != null\) \{ activitySupplier\.get\(\)\.runOnUiThread\(\(\) -> \{ if \(mAdView != null\) \{/);
  assert.match(remove, /mAdView = null;[^}]*notifyListeners\(BannerAdPluginEvents\.SizeChanged\.getWebEventName\(\), sizeInfo\); \} \}\); \} call\.resolve\(\); \} catch/);
  const resume = squeezed(methodBody(banner, /public void resumeBanner\(final PluginCall call\) \{/));
  assert.match(resume, /runOnUiThread\(\(\) -> \{ if \(mAdViewLayout != null && mAdView != null\) \{/);
  assert.match(resume, /\}\); call\.resolve\(\); \} catch/);
  // hideBanner is the odd one out: it rejects without a view and answers from the UI thread.
  const hide = squeezed(methodBody(banner, /public void hideBanner\(final PluginCall call\) \{/));
  assert.match(hide, /if \(mAdView == null\) \{ call\.reject\("You tried to hide a banner that was never shown"\); return; \}/);
});

test('admob plugin: the banner is lifted by the bottom inset that reaches it, and by nothing else', () => {
  // The bridge reports the banner's height plus the page's bottom inset (banner.ts height()).
  // That is right only if the inset the page is told about is the inset this listener sees,
  // which is what MainActivity's edge-to-edge call makes true on Android 14 and earlier
  // (see scripts/configure-android.mjs).
  const show = squeezed(methodBody(banner, /public void showBanner\(final PluginCall call, boolean systemBarsHandlesInsets\) \{/));
  assert.match(show, /mAdViewLayout\.setOnApplyWindowInsetsListener\(\(v, insets\) -> \{/);
  assert.match(show, /Insets safeArea = compat\.getInsets\(WindowInsetsCompat\.Type\.systemBars\(\) \| WindowInsetsCompat\.Type\.displayCutout\(\)\);/);
  assert.match(show, /int bottomInset = keyboardVisible && systemBarsHandlesInsets \? 0 : safeArea\.bottom;/);
  assert.match(show, /mAdViewLayoutParams\.setMargins\(margins\[0\], margins\[1\], margins\[2\], margins\[3\] \+ bottomInset\);/);
  // The bridge asks for margin 0, so that sum is the inset alone.
  assert.match(show, /int densityMargin = \(int\) \(adOptions\.margin \* density\);/);
});

// --- @capacitor/app: Back, pause and resume ----------------------------------------------------
// src/bridge/app-state.ts (createOnBack, createActivityWatch), createFakeAndroidApp.

const app = source('@capacitor', 'app', 'android', 'src', 'main', 'java', 'com', 'capacitorjs', 'plugins', 'app', 'AppPlugin.java');

test('app plugin: Back is swallowed, and does nothing in a one-page app until the page listens', () => {
  const load = squeezed(methodBody(app, /public void load\(\) \{/));
  assert.match(load, /this\.onBackPressedCallback = new OnBackPressedCallback\(!disableBackButtonHandler\) \{/);
  // Without a listener: one step back in the web view's history, or nothing. With one: only the event.
  assert.match(
    load,
    /public void handleOnBackPressed\(\) \{ if \(!hasListeners\(EVENT_BACK_BUTTON\)\) \{ if \(bridge\.getWebView\(\)\.canGoBack\(\)\) \{ bridge\.getWebView\(\)\.goBack\(\); \} \} else \{[^}]*notifyListeners\(EVENT_BACK_BUTTON, data, true\);/,
  );
  assert.match(squeezed(app), /private static final String EVENT_BACK_BUTTON = "backButton";/);
  // What the bridge does when the game declines: the task goes to the back, the activity stays.
  assert.match(squeezed(methodBody(app, /public void minimizeApp\(PluginCall call\) \{/)), /^\{ getActivity\(\)\.moveTaskToBack\(true\); call\.resolve\(\); \}$/);
  assert.match(squeezed(methodBody(app, /public void exitApp\(PluginCall call\) \{/)), /getActivity\(\)\.finish\(\);/);
});

test('app plugin: pause and resume follow the activity one to one; resume only after a first pause', () => {
  assert.match(squeezed(methodBody(app, /protected void handleOnPause\(\) \{/)), /hasPausedEver = true; notifyListeners\(EVENT_PAUSE, null\);/);
  assert.match(squeezed(methodBody(app, /protected void handleOnResume\(\) \{/)), /if \(hasPausedEver\) \{ notifyListeners\(EVENT_RESUME, null\); \}/);
  assert.match(squeezed(app), /private static final String EVENT_PAUSE = "pause"; private static final String EVENT_RESUME = "resume";/);
});
