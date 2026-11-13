import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_web.js';

const D = await load('dates.js');
const { defaultState, mergeState, sanitize, createStore } = await load('store.js');
const { interstitialDue, createAdManager, AD_RULES } = await load('ads.js');
const { noAds, noIap } = await load('platform.js');

test('date keys, day numbers and the countdown', () => {
  assert.equal(D.dateKey(new Date(2026, 10, 13, 23, 59)), '2026-11-13');
  assert.equal(D.dateKey(new Date(2027, 0, 5)), '2027-01-05');
  assert.equal(D.dailyNumber(D.DAILY_EPOCH), 1);
  assert.equal(D.dailyNumber('2026-11-14'), 2);
  assert.equal(D.dailyNumber('2027-11-13'), 366);
  assert.equal(D.daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(D.daysBetween('2028-02-28', '2028-03-01'), 2, 'leap year');
  assert.equal(D.msUntilTomorrow(new Date(2026, 10, 13, 23, 0, 0)), 3600000);
  assert.equal(D.formatCountdown(7 * 3600000 + 12 * 60000), '7h 12m');
  assert.equal(D.formatCountdown(65000), '1m 05s');
  assert.equal(D.formatCountdown(-5), '0m 00s');
  // Where the text is not redrawn every second, the last hour is shown in whole minutes.
  assert.equal(D.formatCountdown(7 * 3600000 + 12 * 60000, { seconds: false }), '7h 12m');
  assert.equal(D.formatCountdown(29 * 60000 + 59000, { seconds: false }), '30m');
  assert.equal(D.formatCountdown(20000, { seconds: false }), '1m');
  // A clock set before launch day never shows "Daily #0".
  assert.equal(D.dailyLabelNumber('2026-11-12'), 1);
  assert.equal(D.dailyLabelNumber('2026-11-15'), 3);
});

test('a calendar that moves backwards neither hides nor resets a streak', () => {
  const d = { streak: 6, best: 9, lastSolved: '2026-12-10' };
  assert.equal(D.liveStreak(d, '2026-12-09'), 6, 'flying west across the date line');
  assert.deepEqual(D.applyDailySolve(d, '2026-12-09'), { streak: 6, best: 9, lastSolved: '2026-12-10' });
  assert.deepEqual(D.applyDailySolve(d, '2026-12-11'), { streak: 7, best: 9, lastSolved: '2026-12-11' });
});

test('streaks grow on consecutive days and reset after a gap', () => {
  let d = { streak: 0, best: 0, lastSolved: null };
  d = D.applyDailySolve(d, '2026-11-13');
  assert.deepEqual(d, { streak: 1, best: 1, lastSolved: '2026-11-13' });
  d = D.applyDailySolve(d, '2026-11-13');
  assert.equal(d.streak, 1, 'solving twice on one day counts once');
  d = D.applyDailySolve(d, '2026-11-14');
  d = D.applyDailySolve(d, '2026-11-15');
  assert.deepEqual(d, { streak: 3, best: 3, lastSolved: '2026-11-15' });
  assert.equal(D.liveStreak(d, '2026-11-15'), 3);
  assert.equal(D.liveStreak(d, '2026-11-16'), 3, 'still alive until the day is missed');
  assert.equal(D.liveStreak(d, '2026-11-17'), 0);
  d = D.applyDailySolve(d, '2026-11-18');
  assert.deepEqual(d, { streak: 1, best: 3, lastSolved: '2026-11-18' });
});

test('a damaged or older save is repaired without losing progress', () => {
  const base = defaultState();
  assert.deepEqual(mergeState(defaultState(), null), base);
  assert.deepEqual(mergeState(defaultState(), 'garbage'), base);
  assert.deepEqual(mergeState(defaultState(), []), base);
  const merged = mergeState(defaultState(), {
    level: 42,
    hints: 'lots',
    settings: { sound: false, junk: 1 },
    stars: { 1: 3, 2: 2 },
    seen: { arrows: true },
    daily: { streak: 4, lastSolved: '2026-11-12', history: { '2026-11-12': { won: true } } },
    resume: { campaign: { id: 42, taps: [1, 0] } },
    somethingNew: true,
  });
  assert.equal(merged.level, 42);
  assert.equal(merged.hints, 3, 'a value of the wrong type falls back to the default');
  assert.deepEqual(merged.settings, { sound: false, haptics: true });
  assert.deepEqual(merged.stars, { 1: 3, 2: 2 });
  assert.deepEqual(merged.seen, { arrows: true });
  assert.equal(merged.daily.streak, 4);
  assert.equal(merged.daily.best, 0);
  assert.equal(merged.daily.lastSolved, '2026-11-12');
  assert.deepEqual(merged.daily.history, { '2026-11-12': { won: true } });
  assert.deepEqual(merged.resume, { campaign: { id: 42, taps: [1, 0] }, daily: null });
  assert.equal('somethingNew' in merged, false);
});

test('the store loads, saves and survives storage that throws', async () => {
  const disk = new Map();
  const persist = { get: async (k) => disk.get(k) ?? null, set: async (k, v) => void disk.set(k, v) };
  const store = createStore(persist);
  await store.load();
  store.state.level = 7;
  store.save();
  await store.flush();
  const again = createStore(persist);
  await again.load();
  assert.equal(again.state.level, 7);
  disk.set('save.v1', '{not json');
  const broken = createStore(persist);
  await broken.load();
  assert.equal(broken.state.level, 1);
});

test('a copy of the game that changed nothing never overwrites newer progress', async () => {
  const disk = new Map();
  let writes = 0;
  const persist = { get: async (k) => disk.get(k) ?? null, set: async (k, v) => void (writes++, disk.set(k, v)) };
  const oldTab = createStore(persist);
  await oldTab.load();
  const newTab = createStore(persist);
  await newTab.load();
  newTab.state.level = 12;
  newTab.save();
  await newTab.flush();
  assert.equal(writes, 1);
  // The old tab is hidden or closed without having changed anything.
  await oldTab.flush();
  assert.equal(writes, 1, 'nothing was written');
  assert.equal(JSON.parse(disk.get('save.v1')).level, 12);
  // After a reset the store really is empty again.
  await newTab.reset();
  assert.equal(JSON.parse(disk.get('save.v1')).level, 1);
});

test('values of the wrong type in a save are replaced, so the game always starts', () => {
  const bad = mergeState(defaultState(), {
    level: 2.5,
    hints: -4,
    stars: { 3: 9, x: 2, 7: 2 },
    seen: { arrows: 'yes', short: true },
    stats: { solved: 'many' },
    daily: {
      streak: 5,
      lastSolved: 20261113,
      repairOffered: ['2026-11-12'],
      history: {
        '2026-11-12': { won: true, stars: 1e9, slips: -1, extra: 1e9, story: '10x1', taps: '0a!1' },
        nonsense: { won: true },
        '2026-11-11': 'solved',
      },
    },
    resume: { campaign: { id: 7, taps: [0, null, true, 1.5, 3, 99], extra: 1e9, hints: 'two' }, daily: { taps: [1] } },
    ads: { levelsSince: 'lots' },
  });
  const s = sanitize(bad);
  assert.equal(s.level, 1);
  assert.equal(s.hints, 3);
  assert.deepEqual(s.stars, { 7: 2 });
  assert.deepEqual(s.seen, { arrows: false, short: true });
  assert.equal(s.stats.solved, 0);
  assert.equal(s.daily.lastSolved, null);
  assert.equal(s.daily.streak, 0, 'a streak with no date to hang on is dropped');
  assert.equal(s.daily.repairOffered, null);
  assert.deepEqual(s.daily.history, {
    '2026-11-12': { won: true, slips: 0, stars: 0, hints: 0, extra: 0, story: '101', taps: '0a1' },
  });
  assert.deepEqual(s.resume.campaign, { id: 7, taps: [0, 3], hints: 0, extra: 0, hinted: -1 });
  assert.equal(s.resume.daily, null, 'an attempt with no level to belong to is dropped');
  assert.equal(s.ads.levelsSince, 0);
  // A healthy save passes through untouched.
  const good = defaultState();
  good.level = 40;
  good.daily.lastSolved = '2026-11-13';
  good.daily.streak = 3;
  good.resume.daily = { id: '2026-11-13', taps: [2, 0], hints: 1, extra: 1, hinted: 5 };
  assert.deepEqual(sanitize(JSON.parse(JSON.stringify(good))), good);
});

test('full-screen adverts respect the grace period, the gap in levels and the gap in time', () => {
  const ok = { removeAds: false, solvedTotal: 10, levelsSince: 3, lastAt: 0, now: 200000 };
  assert.equal(interstitialDue(ok), true);
  assert.equal(interstitialDue({ ...ok, removeAds: true }), false);
  assert.equal(interstitialDue({ ...ok, solvedTotal: AD_RULES.graceLevels - 1 }), false);
  assert.equal(interstitialDue({ ...ok, levelsSince: AD_RULES.minLevelsBetween - 1 }), false);
  assert.equal(interstitialDue({ ...ok, now: AD_RULES.minSecondsBetween * 1000 - 1 }), false);
});

function fakeWorld({ enabled = true, rewardedReady = true, earn = true } = {}) {
  const shown = [];
  let clock = 1_000_000;
  let bannerOn = false;
  const ads = {
    ...noAds,
    name: 'fake',
    enabled: () => enabled,
    showBanner: async () => void (bannerOn = true),
    hideBanner: async () => void (bannerOn = false),
    interstitialReady: () => true,
    showInterstitial: async () => (shown.push('interstitial'), true),
    rewardedReady: () => rewardedReady,
    showRewarded: async () => (shown.push('rewarded'), earn),
  };
  let owned = false;
  const iap = { ...noIap, available: () => true, owned: async () => owned, purchase: async () => ((owned = true), 'purchased'), restore: async () => owned };
  /** As if the App Store approved a purchase while the app was away. */
  const approveLater = () => void (owned = true);
  const state = defaultState();
  const store = { state, save() {} };
  const events = [];
  const manager = createAdManager({
    platform: { ads, iap },
    store,
    now: () => clock,
    hooks: { onOpen: () => events.push('open'), onClose: () => events.push('close'), onEntitlement: (o) => events.push(`owned:${o}`) },
  });
  return { manager, state, shown, events, approveLater, banner: () => bannerOn, tick: (s) => void (clock += s * 1000) };
}

test('the advert manager paces full-screen adverts through a session', async () => {
  const w = fakeWorld();
  await w.manager.init();
  const finishLevel = async () => {
    w.state.stats.solved++;
    w.manager.levelCompleted();
    w.tick(40);
    return w.manager.interstitialIfDue();
  };
  const results = [];
  for (let i = 0; i < 10; i++) results.push(await finishLevel());
  // Nothing for the first eight levels; after that, at most one every three levels.
  assert.deepEqual(results, [false, false, false, false, false, false, false, true, false, false]);
  for (let i = 0; i < 4; i++) results.push(await finishLevel());
  assert.deepEqual(results.slice(10), [true, false, false, true]);
  assert.equal(w.events.filter((e) => e === 'open').length, 3);

  // Coming back to the app later does not put an advert in front of the very next level.
  const back = fakeWorld();
  back.state.stats.solved = 30;
  back.state.ads.levelsSince = 5;
  await back.manager.init();
  back.manager.levelCompleted();
  back.tick(30);
  assert.equal(await back.manager.interstitialIfDue(), false, 'not within the first 110 seconds of a session');
  back.tick(100);
  assert.equal(await back.manager.interstitialIfDue(), true);
});

test('a rewarded video only pays out when earned, and buys a rest from full-screen adverts', async () => {
  const w = fakeWorld({ earn: false });
  await w.manager.init();
  assert.equal(w.manager.rewardMode(), 'ad');
  assert.equal(await w.manager.watchRewarded(), false);
  w.state.stats.solved = 20;
  w.state.ads.levelsSince = 9;
  assert.equal(await w.manager.interstitialIfDue(), false, 'the clock was reset by the video');

  const none = fakeWorld({ rewardedReady: false });
  assert.equal(none.manager.rewardMode(), 'none');
  assert.equal(await none.manager.watchRewarded(), false);

  const web = fakeWorld({ enabled: false });
  assert.equal(web.manager.rewardMode(), 'free');
  assert.equal(await web.manager.watchRewarded(), true, 'with no advert system, rewards are simply given');
  assert.equal(await web.manager.interstitialIfDue(), false);
});

test('a purchase approved while the app was away is picked up when it comes back', async () => {
  const w = fakeWorld();
  await w.manager.init();
  w.manager.setBanner(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(w.state.removeAds, false);
  w.approveLater();
  w.manager.checkEntitlement();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(w.state.removeAds, true);
  assert.equal(w.banner(), false);
  assert.deepEqual(w.events.filter((e) => e.startsWith('owned')), ['owned:true']);
  // Asking again changes nothing and never takes the purchase away.
  w.manager.checkEntitlement();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(w.state.removeAds, true);
});

test('buying Remove Ads turns off the banner and full-screen adverts for good', async () => {
  const w = fakeWorld();
  await w.manager.init();
  w.manager.setBanner(true);
  assert.equal(w.banner(), true);
  assert.equal(await w.manager.buyRemoveAds(), 'purchased');
  assert.equal(w.state.removeAds, true);
  assert.equal(w.banner(), false);
  assert.ok(w.events.includes('owned:true'));
  w.state.stats.solved = 50;
  w.state.ads.levelsSince = 9;
  w.tick(1000);
  assert.equal(await w.manager.interstitialIfDue(), false);
  assert.equal(w.manager.rewardMode(), 'ad', 'optional reward videos stay available');
});
