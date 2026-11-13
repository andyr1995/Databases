// Start-up: choose the platform, load the save, show the first screen.

import { initPlatform, platform } from './platform.js';
import { createStore } from './store.js';
import { createAdManager } from './ads.js';
import { createShell } from './shell.js';
import { homeScreen } from './screen-home.js';
import { gameScreen } from './screen-game.js';
import { openSettings, openStats, openHelp, openRemoveAds, maybeOfferStreakRepair } from './sheets.js';
import { setSoundEnabled, setDucked, unlockAudio } from './synth.js';
import { ECONOMY } from './config.js';

async function boot() {
  await initPlatform();
  const store = createStore(platform.persist);
  await store.load();
  setSoundEnabled(store.state.settings.sound);

  const params = new URLSearchParams(location.search);
  const shell = createShell(document.getElementById('app'));
  /** @type {{el: HTMLElement, refresh?: () => void, destroy?: () => void} | null} */
  let screen = null;
  let adOpen = false;
  let active = true;
  const syncAudio = () => setDucked(adOpen || !active);

  const app = {
    platform,
    store,
    shell,
    /** @type {ReturnType<typeof createAdManager>} */
    ads: /** @type {any} */ (null),
    haptic(kind) {
      if (store.state.settings.haptics) platform.haptic(kind);
    },
    goHome() {
      screen = homeScreen(app);
      shell.show(screen);
      maybeOfferStreakRepair(app);
    },
    /** @param {'campaign'|'daily'} mode @param {number} [level] */
    play(mode, level) {
      screen = gameScreen(app, { mode, level });
      shell.show(screen);
    },
    /** Something shown on the current screen changed (hints, adverts, streak). */
    refresh() {
      if (screen && screen.refresh) screen.refresh();
    },
    openSettings: () => openSettings(app),
    openStats: () => openStats(app),
    openHelp: () => openHelp(app),
    openRemoveAds: () => openRemoveAds(app),
  };

  app.ads = createAdManager({
    platform,
    store,
    // With simulated adverts, `&fast` also shortens the waiting rules so a test can reach an advert quickly.
    rules: platform.ads.name === 'mock' && params.has('fast') ? { graceLevels: 2, minLevelsBetween: 2, minSecondsBetween: 0 } : undefined,
    hooks: {
      onOpen: () => {
        adOpen = true;
        syncAudio();
      },
      onClose: () => {
        adOpen = false;
        syncAudio();
      },
      onBannerHeight: (px) => document.documentElement.style.setProperty('--banner', `${Math.max(0, Math.round(px))}px`),
      onEntitlement: (owned) => {
        if (owned && !store.state.purchaseBonus) {
          store.state.purchaseBonus = true;
          store.state.hints += ECONOMY.hintsWithPurchase;
          store.save();
        }
        app.refresh();
      },
    },
  });

  platform.onActiveChange((isActive) => {
    active = isActive;
    syncAudio();
    if (isActive) app.refresh();
    else store.flush();
  });
  window.addEventListener('pagehide', () => store.flush());
  document.addEventListener('pointerdown', unlockAudio, true);

  // `?level=12` jumps to a level (handy for testing and for store screenshots).
  const jump = Number(params.get('level'));
  const brandNew = store.state.stats.solved === 0 && store.state.level === 1;
  if (jump >= 1) app.play('campaign', Math.floor(jump));
  else if (params.has('daily')) app.play('daily');
  else if (brandNew) app.play('campaign');
  else app.goHome();

  if (params.has('debug')) /** @type {any} */ (window).__app = app;

  platform.appReady();
  // Consent and advert loading carry on in the background; play never waits for them.
  app.ads.init().then(() => app.refresh());
}

boot().catch((err) => {
  console.error(err);
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML =
    '<div class="fatal"><p>Something went wrong starting the game.</p><button type="button" onclick="location.reload()">Try again</button></div>';
});
