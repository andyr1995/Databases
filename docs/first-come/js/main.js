// Start-up: choose the platform, load the save, show the first screen.

import { initPlatform, platform } from './platform.js';
import { createStore, SAVE_KEY } from './store.js';
import { createAdManager, AD_RULES } from './ads.js';
import { h } from './dom.js';
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
  /** Which screen is showing, for things that only make sense on one of them. */
  let onHome = false;
  /** When the app last left the front, to tell a glance away from a real absence. */
  let awaySince = 0;
  let bannerWanted = false;
  let bannerPx = 0;
  /** The cover shown while a full-screen advert is on its way, and its "taking too long" timer. */
  let cover = null;
  let coverTimer = null;
  const syncAudio = () => setDucked(adOpen || !active);
  // A banner height only counts while a banner is wanted: a late report after the
  // banner was hidden must not leave an empty strip on a screen that has no banner.
  const syncBannerSpace = () =>
    document.documentElement.style.setProperty('--banner', `${bannerWanted ? Math.max(0, Math.round(bannerPx)) : 0}px`);

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
      onHome = true;
      screen = homeScreen(app);
      shell.show(screen);
      maybeOfferStreakRepair(app);
    },
    /** @param {'campaign'|'daily'} mode @param {number} [level] */
    play(mode, level) {
      if (mode === 'daily') {
        // Opened straight into the Daily: put Home behind any question that comes first.
        if (!screen) {
          onHome = true;
          screen = homeScreen(app);
          shell.show(screen);
        }
        // A streak that can still be saved is offered before today's Daily is started,
        // because solving the Daily first would start the streak again from 1.
        if (maybeOfferStreakRepair(app, () => app.play('daily'))) return;
      }
      onHome = false;
      screen = gameScreen(app, { mode, level });
      shell.show(screen);
    },
    /** Offer to save a missed-day streak if one is owed (Home calls this when the date changes). */
    offerStreakRepair: () => maybeOfferStreakRepair(app),
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
    rules:
      platform.ads.name === 'mock' && params.has('fast')
        ? { ...AD_RULES, graceLevels: 2, minLevelsBetween: 2, minSecondsBetween: 0, noticeMs: 150, patienceMs: 1500 }
        : undefined,
    hooks: {
      // While an advert is on its way the whole screen is covered, so the player cannot
      // wander off (and lose a reward) or be surprised by an advert under their finger.
      // If it takes far too long, the cover offers a way back to the game.
      onOpen: ({ kind, patienceMs, cancel }) => {
        adOpen = true;
        syncAudio();
        const message = h('p', { text: kind === 'rewarded' ? 'Loading video…' : 'Advert' });
        cover = h('div.ad-cover', { role: 'status' }, message);
        document.body.append(cover);
        const mine = cover;
        coverTimer = setTimeout(() => {
          message.textContent = 'This is taking a while.';
          const back = h('button.secondary', { type: 'button', text: 'Back to the game' });
          back.addEventListener('click', cancel);
          mine.append(back);
        }, patienceMs);
      },
      onClose: () => {
        adOpen = false;
        syncAudio();
        clearTimeout(coverTimer);
        if (cover) cover.remove();
        cover = null;
      },
      onBannerHeight: (px) => {
        bannerPx = px;
        syncBannerSpace();
      },
      // Keep a strip free for the banner from the moment one is wanted, so nothing moves when it loads.
      onBannerWanted: (wanted) => {
        bannerWanted = wanted;
        document.documentElement.classList.toggle('banner-wanted', wanted);
        syncBannerSpace();
      },
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
    if (isActive) {
      // Back after a real absence: no full-screen advert for the first two minutes.
      if (awaySince && Date.now() - awaySince > 3 * 60 * 1000) app.ads.resumed();
      awaySince = 0;
      app.refresh();
      // A purchase may have been approved while the app was away (Ask to Buy).
      app.ads.checkEntitlement();
      // A phone usually brings the app back as it was left, without rebuilding Home:
      // a streak that can be saved is offered here too.
      if (onHome && !shell.sheetOpen()) maybeOfferStreakRepair(app);
    } else {
      if (!awaySince) awaySince = Date.now();
      store.flush();
    }
  });
  window.addEventListener('pagehide', () => store.flush());
  document.addEventListener('pointerdown', unlockAudio, true);
  // The web version can be open in two tabs. When the other tab saves, take its
  // progress rather than later overwriting it with this tab's older copy.
  window.addEventListener('storage', (e) => {
    if (e.key !== SAVE_KEY || e.newValue === null) return;
    store.load().then(() => {
      setSoundEnabled(store.state.settings.sound);
      app.goHome();
    });
  });

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
  // "Try again" covers a passing fault. "Start afresh" is the way out if the saved
  // progress itself is what stops the game from starting.
  root.innerHTML =
    '<div class="fatal"><p>Something went wrong starting the game.</p>' +
    '<button type="button" id="fatal-retry">Try again</button>' +
    '<button type="button" id="fatal-reset" class="quiet">Start afresh (clears progress)</button></div>';
  document.getElementById('fatal-retry').addEventListener('click', () => location.reload());
  document.getElementById('fatal-reset').addEventListener('click', async () => {
    try {
      await platform.persist.set(SAVE_KEY, '{}');
    } catch {
      /* nothing more can be done */
    }
    location.reload();
  });
});
