// The part of app.config.json that is compiled into the bridge.

export interface AdUnitIds {
  /**
   * AdMob app id. Not used by the bridge: it belongs in the native project
   * (Info.plist GADApplicationIdentifier on iOS, the com.google.android.gms.ads.APPLICATION_ID
   * meta-data of AndroidManifest.xml on Android).
   */
  appId: string;
  banner: string;
  interstitial: string;
  rewarded: string;
}

export interface AdmobConfig {
  /** true: only Google's demo ad units are ever requested. Must be false in the store builds. */
  testing: boolean;
  ios?: AdUnitIds;
  android?: AdUnitIds;
}

export interface BridgeConfig {
  admob: AdmobConfig;
  iap: { removeAdsProductId: string };
}

export interface AdUnits {
  banner: string;
  interstitial: string;
  rewarded: string;
}

/** Google's demo publisher. Every ad unit under it serves test creatives and earns nothing. */
export const GOOGLE_DEMO_PUBLISHER = 'ca-app-pub-3940256099942544';

/**
 * Google's demo ad units for iOS, from https://developers.google.com/admob/ios/test-ads
 * (read on 2026-11-13). The banner is the "Anchored Adaptive Banner" unit, because that is
 * the format the bridge requests.
 *
 * The plugin's own `isTesting` option is deliberately not used: on iOS it swaps in ids that
 * are hard-coded in AdMobPlugin.swift, and for banner (6300978111) and interstitial
 * (1033173712) those are the Android demo units.
 */
export const GOOGLE_IOS_DEMO_UNITS: AdUnits = {
  banner: `${GOOGLE_DEMO_PUBLISHER}/2435281174`,
  interstitial: `${GOOGLE_DEMO_PUBLISHER}/4411468910`,
  rewarded: `${GOOGLE_DEMO_PUBLISHER}/1712485313`,
};

/** Google's sample AdMob app id for iOS, from https://developers.google.com/admob/ios/quick-start */
export const GOOGLE_IOS_SAMPLE_APP_ID = `${GOOGLE_DEMO_PUBLISHER}~1458002511`;

/**
 * Google's demo ad units for Android, from https://developers.google.com/admob/android/test-ads
 * (read on 2026-11-14): "Anchored Adaptive Banner", "Interstitial" and "Rewarded Ads".
 *
 * `isTesting` is not used on Android either. There (helpers/AdViewIdHelper.java and
 * models/AdOptions.java) it swaps in the FIXED SIZE banner unit (6300978111) for the adaptive
 * banner the bridge asks for, and on a phone registered as a test device it leaves the real
 * ad unit in place.
 */
export const GOOGLE_ANDROID_DEMO_UNITS: AdUnits = {
  banner: `${GOOGLE_DEMO_PUBLISHER}/9214589741`,
  interstitial: `${GOOGLE_DEMO_PUBLISHER}/1033173712`,
  rewarded: `${GOOGLE_DEMO_PUBLISHER}/5224354917`,
};

/** Google's sample AdMob app id for Android, from https://developers.google.com/admob/android/quick-start */
export const GOOGLE_ANDROID_SAMPLE_APP_ID = `${GOOGLE_DEMO_PUBLISHER}~3347511713`;

/** The operating systems the app ships on, with what the config must hold for each. */
const STORES = [
  { os: 'ios', label: 'iOS', demo: GOOGLE_IOS_DEMO_UNITS },
  { os: 'android', label: 'Android', demo: GOOGLE_ANDROID_DEMO_UNITS },
] as const;

export function isDemoUnit(id: string): boolean {
  return typeof id === 'string' && id.startsWith(`${GOOGLE_DEMO_PUBLISHER}/`);
}

/**
 * The ad units to request on this OS, or null when the config has none for it
 * (the bridge then installs a provider that never has an ad).
 *
 * With `testing` on, a real ad unit id is replaced by Google's demo unit for the same
 * format and the same OS, so a development build cannot generate invalid traffic on a live
 * account.
 */
export function resolveAdUnits(admob: AdmobConfig, os: string): AdUnits | null {
  const store = STORES.find((s) => s.os === os);
  const ids = store ? admob[store.os] : undefined;
  if (!store || !ids) return null;
  const pick = (id: string, demo: string): string => (admob.testing && !isDemoUnit(id) ? demo : id);
  return {
    banner: pick(ids.banner, store.demo.banner),
    interstitial: pick(ids.interstitial, store.demo.interstitial),
    rewarded: pick(ids.rewarded, store.demo.rewarded),
  };
}

/** Things worth telling whoever runs the build. Empty when the config is fit for release. */
export function configWarnings(config: BridgeConfig): string[] {
  const out: string[] = [];
  if (config.admob.testing) {
    out.push('admob.testing is true: this build only requests Google demo ads and earns nothing.');
  }
  for (const { os, label } of STORES) {
    const ids = config.admob[os];
    if (!ids) {
      out.push(`admob.${os} is missing: the ${label} app will show no ads.`);
      continue;
    }
    if (config.admob.testing) continue;
    const demo = (['banner', 'interstitial', 'rewarded'] as const).filter((k) => isDemoUnit(ids[k]));
    if (demo.length) out.push(`admob.testing is false but these admob.${os} ids are still Google demo units: ${demo.join(', ')}.`);
    if (typeof ids.appId === 'string' && ids.appId.startsWith(`${GOOGLE_DEMO_PUBLISHER}~`)) {
      out.push(`admob.testing is false but admob.${os}.appId is still Google's sample app id.`);
    }
  }
  if (!config.iap.removeAdsProductId) out.push('iap.removeAdsProductId is empty: Remove Ads cannot be bought.');
  return out;
}
