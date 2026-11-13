// Simulated ads and purchases for the browser (`?ads=mock`).
// They follow the same contract as the real AdMob / StoreKit providers, so the
// placement rules, reward flow and layout can be previewed and tested without a device.

/** @returns {import('./platform.js').AdProvider} */
export function createMockAds({ fast = false, hang = false } = {}) {
  const seconds = fast ? 1 : 4;
  let bannerEl = null;
  let heightCb = () => {};
  let ready = false;
  const log = [];
  /** Tests read this to see what was shown. */
  /** @type {any} */ (window).__mockAds = { log };

  const overlay = (kind) =>
    new Promise((resolve) => {
      log.push(kind);
      const el = document.createElement('div');
      el.className = 'mock-ad';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Test advert');
      el.style.cssText =
        'position:fixed;inset:0;z-index:99999;background:#101418;color:#fff;display:flex;flex-direction:column;' +
        'align-items:center;justify-content:center;gap:18px;font:600 18px system-ui,sans-serif;text-align:center;padding:24px';
      const label = document.createElement('div');
      label.textContent = kind === 'rewarded' ? 'Test rewarded video' : 'Test full-screen advert';
      const note = document.createElement('div');
      note.style.cssText = 'font-weight:400;font-size:14px;opacity:.7;max-width:260px';
      note.textContent = 'Real adverts appear here in the app.';
      const btn = document.createElement('button');
      btn.className = 'mock-ad-close';
      btn.style.cssText =
        'font:600 16px system-ui,sans-serif;padding:12px 22px;border-radius:999px;border:0;background:#fff;color:#101418;min-width:150px';
      el.append(label, note, btn);
      if (kind === 'rewarded') {
        // Real rewarded videos can be closed early, forfeiting the reward.
        const skip = document.createElement('button');
        skip.className = 'mock-ad-skip';
        skip.textContent = 'Close without the reward';
        skip.style.cssText = 'font:500 14px system-ui,sans-serif;padding:10px;border:0;background:none;color:#fff;opacity:.7;text-decoration:underline';
        skip.addEventListener('click', () => {
          clearInterval(timer);
          el.remove();
          resolve(false);
        });
        el.append(skip);
      }
      document.body.appendChild(el);

      let left = seconds;
      let earned = false;
      let timer = 0;
      const paint = () => {
        if (left > 0) {
          btn.textContent = kind === 'rewarded' ? `Reward in ${left}` : `Close in ${left}`;
          btn.disabled = true;
          btn.style.opacity = '.5';
        } else {
          earned = true;
          btn.textContent = kind === 'rewarded' ? 'Collect reward' : 'Close';
          btn.disabled = false;
          btn.style.opacity = '1';
        }
      };
      paint();
      timer = setInterval(() => {
        left -= 1;
        paint();
        if (left <= 0) clearInterval(timer);
      }, 1000);
      btn.addEventListener('click', () => {
        clearInterval(timer);
        el.remove();
        resolve(earned);
      });
    });

  /** `&hang`: an advert that never appears and never answers, to test the way out. */
  const never = (kind) => {
    log.push(`${kind}:hung`);
    return new Promise(() => {});
  };

  return {
    name: 'mock',
    init: async () => {
      ready = true;
    },
    enabled: () => true,
    showBanner: async () => {
      if (bannerEl) return;
      bannerEl = document.createElement('div');
      bannerEl.className = 'mock-banner';
      bannerEl.textContent = 'Test banner advert';
      bannerEl.style.cssText =
        'position:fixed;left:0;right:0;bottom:0;height:calc(50px + env(safe-area-inset-bottom, 0px));z-index:9000;' +
        'box-sizing:border-box;padding-bottom:env(safe-area-inset-bottom, 0px);background:#dfe3e8;color:#56606b;' +
        'display:flex;align-items:center;justify-content:center;font:500 13px system-ui,sans-serif';
      document.body.appendChild(bannerEl);
      heightCb(Math.round(bannerEl.getBoundingClientRect().height));
    },
    hideBanner: async () => {
      if (!bannerEl) return;
      bannerEl.remove();
      bannerEl = null;
      heightCb(0);
    },
    onBannerHeight: (cb) => {
      heightCb = cb;
      if (bannerEl) cb(Math.round(bannerEl.getBoundingClientRect().height));
    },
    interstitialReady: () => ready,
    showInterstitial: async () => {
      if (hang) return never('interstitial');
      await overlay('interstitial');
      return true;
    },
    rewardedReady: () => ready,
    showRewarded: () => (hang ? never('rewarded') : overlay('rewarded')),
    privacyOptionsRequired: () => true,
    showPrivacyOptions: async () => {
      log.push('privacy');
    },
  };
}

/** @returns {import('./platform.js').IapProvider} */
export function createMockIap() {
  let owned = false;
  return {
    available: () => true,
    product: async () => ({ price: '£2.99' }),
    owned: async () => owned,
    purchase: async () => {
      owned = true;
      return 'purchased';
    },
    restore: async () => owned,
  };
}
