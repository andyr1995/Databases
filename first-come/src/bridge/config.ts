// The part of app.config.json that is compiled into the bridge.

export interface AdUnitIds {
  /** AdMob app id. Not used by the bridge: it belongs in Info.plist (GADApplicationIdentifier). */
  appId: string;
  banner: string;
  interstitial: string;
  rewarded: string;
}

export interface AdmobConfig {
  /** true: only Google's demo ad units are ever requested. Must be false in the App Store build. */
  testing: boolean;
  ios?: AdUnitIds;
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

export function isDemoUnit(id: string): boolean {
  return typeof id === 'string' && id.startsWith(`${GOOGLE_DEMO_PUBLISHER}/`);
}

/**
 * The ad units to request on this OS, or null when the config has none for it
 * (the bridge then leaves the game's "no ads" provider in place).
 *
 * With `testing` on, a real ad unit id is replaced by Google's demo unit for the same
 * format, so a development build cannot generate invalid traffic on a live account.
 */
export function resolveAdUnits(admob: AdmobConfig, os: string): AdUnits | null {
  const ids = os === 'ios' ? admob.ios : undefined;
  if (!ids) return null;
  const pick = (id: string, demo: string): string => (admob.testing && !isDemoUnit(id) ? demo : id);
  return {
    banner: pick(ids.banner, GOOGLE_IOS_DEMO_UNITS.banner),
    interstitial: pick(ids.interstitial, GOOGLE_IOS_DEMO_UNITS.interstitial),
    rewarded: pick(ids.rewarded, GOOGLE_IOS_DEMO_UNITS.rewarded),
  };
}

/** Things worth telling whoever runs the build. Empty when the config is fit for release. */
export function configWarnings(config: BridgeConfig): string[] {
  const out: string[] = [];
  const ios = config.admob.ios;
  if (!ios) {
    out.push('admob.ios is missing: the iOS app will show no ads.');
  } else {
    const demo = (['banner', 'interstitial', 'rewarded'] as const).filter((k) => isDemoUnit(ios[k]));
    const sampleApp = ios.appId === GOOGLE_IOS_SAMPLE_APP_ID || ios.appId.startsWith(`${GOOGLE_DEMO_PUBLISHER}~`);
    if (config.admob.testing) {
      out.push('admob.testing is true: this build only requests Google demo ads and earns nothing.');
    } else {
      if (demo.length) out.push(`admob.testing is false but these are still Google demo units: ${demo.join(', ')}.`);
      if (sampleApp) out.push('admob.testing is false but admob.ios.appId is still Google\'s sample app id.');
    }
  }
  if (!config.iap.removeAdsProductId) out.push('iap.removeAdsProductId is empty: Remove Ads cannot be bought.');
  return out;
}
