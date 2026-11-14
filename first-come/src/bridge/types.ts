// The contract between the web game and the native bridge.
//
// These types mirror the JSDoc typedefs in <webDir>/js/platform.js. That file is
// the source of truth: test/contract.test.js imports it and fails if the bridge
// drops a member or changes its type.

export type HapticKind = 'tap' | 'soft' | 'heavy' | 'success' | 'error';

export interface SharePayload {
  title?: string;
  text: string;
  url?: string;
}

/** 'copied' is only ever produced by the web fallback; the native sheet reports the other three. */
export type ShareResult = 'shared' | 'copied' | 'cancelled' | 'failed';

export interface Persist {
  /** Resolves null when the key is absent. Never rejects. */
  get(key: string): Promise<string | null>;
  /** Never rejects. */
  set(key: string, value: string): Promise<void>;
}

export interface AdProvider {
  /** 'none' | 'mock' | 'admob' */
  name: string;
  /** Settle consent and start the SDK. Never rejects. */
  init(): Promise<void>;
  /** Whether this provider can ever show an ad. */
  enabled(): boolean;
  showBanner(): Promise<void>;
  hideBanner(): Promise<void>;
  /**
   * Distance in CSS px from the bottom edge of the screen to the top edge of the
   * banner, including any safe-area gap under it (0 when no banner is on screen).
   */
  onBannerHeight(cb: (cssPx: number) => void): void;
  interstitialReady(): boolean;
  /** Resolves on dismissal; true if an ad was shown. */
  showInterstitial(): Promise<boolean>;
  rewardedReady(): boolean;
  /** Resolves on dismissal; true only if the reward was earned. */
  showRewarded(): Promise<boolean>;
  /** True when a "Privacy choices" entry must be offered (GDPR regions). */
  privacyOptionsRequired(): boolean;
  showPrivacyOptions(): Promise<void>;
}

export type PurchaseResult = 'purchased' | 'cancelled' | 'failed';

export interface IapProvider {
  available(): boolean;
  /** Localised price of Remove Ads, or null if the store is unreachable. */
  product(): Promise<{ price: string } | null>;
  /** Whether Remove Ads is currently owned. */
  owned(): Promise<boolean>;
  purchase(): Promise<PurchaseResult>;
  /** True if a previous purchase was found. */
  restore(): Promise<boolean>;
}

/** The `platform` object exported by <webDir>/js/platform.js. */
export interface Platform {
  isNative: boolean;
  /** 'web' | 'ios' | 'android' */
  os: string;
  haptic(kind: HapticKind): void;
  share(payload: SharePayload): Promise<ShareResult>;
  openExternal(url: string): void;
  appReady(): void;
  persist: Persist;
  onActiveChange(cb: (active: boolean) => void): void;
  /**
   * Android's Back (button or gesture). `handler` returns true if the game dealt with the
   * press; if it returns false the app is put in the background. Only one handler is kept.
   * Until the game has given a handler, every press puts the app in the background.
   * Never called on iPhone.
   */
  onBack(handler: () => boolean): void;
  ads: AdProvider;
  iap: IapProvider;
}
