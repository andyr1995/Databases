// The slide-up panels: settings, stats, how to play, remove ads, streak repair.

import { h, icon, ICONS } from './dom.js';
import { button } from './shell.js';
import { blockBadge } from './board.js';
import { N, E, S, W } from './engine.js';
import { dateKey, daysBetween, liveStreak } from './dates.js';
import { APP, ECONOMY } from './config.js';
import { setSoundEnabled } from './synth.js';

function toggleRow(label, value, onChange) {
  const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label });
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label.row', null, h('span', { text: label }), h('span.switch', null, input, h('i')));
}

function linkRow(label, onclick) {
  return button('button.row.link', { onclick }, h('span', { text: label }), icon(ICONS.next, { size: 18 }));
}

export function openSettings(app) {
  const { store, ads, shell, platform } = app;
  const s = store.state.settings;
  const rows = [
    toggleRow('Sound', s.sound, (on) => {
      s.sound = on;
      setSoundEnabled(on);
      store.save();
    }),
    toggleRow('Vibration', s.haptics, (on) => {
      s.haptics = on;
      store.save();
      if (on) app.haptic('soft');
    }),
  ];
  /** @type {{close: () => void}} */
  let sheet;
  let restoring = false;
  if (ads.removeAdsAvailable()) {
    if (!ads.adsOff()) rows.push(linkRow('Remove ads', () => app.openRemoveAds()));
    rows.push(
      linkRow('Restore purchases', async () => {
        if (restoring) return;
        restoring = true;
        const wasOff = ads.adsOff();
        const found = await ads.restorePurchases();
        restoring = false;
        shell.toast(found ? 'Purchase restored. Adverts are off.' : 'No earlier purchase was found.');
        // Draw the sheet again so it stops offering to sell what is now owned.
        if (found && !wasOff) {
          sheet.close();
          openSettings(app);
        }
      }),
    );
  }
  if (ads.privacyOptionsRequired()) rows.push(linkRow('Privacy choices', () => ads.showPrivacyOptions()));
  rows.push(
    linkRow('How to play', () => app.openHelp()),
    linkRow('Privacy policy', () => platform.openExternal(APP.privacyUrl)),
    linkRow('Help and contact', () => platform.openExternal(APP.supportUrl)),
    h('p.fineprint', { text: `${APP.name} ${APP.version}` }),
  );
  sheet = shell.sheet({ title: 'Settings', body: h('div.rows', null, rows) });
  return sheet;
}

export function openStats(app) {
  const s = app.store.state;
  const today = dateKey();
  const stars = Object.values(s.stars).reduce((a, b) => a + b, 0);
  const tile = (value, label) => h('div.tile-stat', null, h('b', { text: String(value) }), h('span', { text: label }));

  // The last seven days of the Daily, oldest first.
  const week = [];
  for (let back = 6; back >= 0; back--) {
    const d = new Date();
    d.setDate(d.getDate() - back);
    const key = dateKey(d);
    const done = s.daily.history[key];
    week.push(
      h(
        `div.day${done ? '.done' : ''}${back === 0 ? '.today' : ''}`,
        null,
        h('span', { text: d.toLocaleDateString(undefined, { weekday: 'narrow' }) }),
        h('i', null, done ? icon(ICONS.check, { size: 16 }) : null),
      ),
    );
  }

  const body = h(
    'div.stats-grid',
    null,
    tile(s.stats.solved, 'Levels solved'),
    tile(stars, 'Stars'),
    tile(s.stats.perfect, 'Perfect solves'),
    tile(liveStreak(s.daily, today), 'Daily streak'),
    tile(s.daily.best, 'Best streak'),
    tile(s.stats.dailies, 'Dailies solved'),
  );
  return app.shell.sheet({ title: 'Your stats', body: [body, h('div.week', { 'aria-label': 'Daily puzzles this week' }, week)] });
}

export function openHelp(app) {
  const item = (art, title, text) => h('div.help-item', null, h('div.art', null, art), h('div', null, h('b', { text: title }), h('p', { text })));
  const body = h(
    'div.help',
    null,
    item(blockBadge(0, N | E | S | W), 'Tap a block', 'Its colour runs out along every arrow and claims each free square, until something is in the way.'),
    item(
      [blockBadge(5, E | W, { size: 40 }), blockBadge(2, N | E, { size: 40 })],
      'First come, first served',
      'A claimed square stays claimed. Whoever goes later gets cut short.',
    ),
    item(icon(ICONS.check, { size: 40 }), 'Fill every square', 'Each block goes once, so the whole puzzle is the order you tap them in.'),
    item(
      h('span.cross-art'),
      'Slips',
      'A tap that would leave a square nobody can reach is undone and counts as a slip. No slips earns three stars.',
    ),
    item(blockBadge(3, N | S, { len: 2 }), 'Arrows and numbers', 'Arrows show which ways a block reaches. A number is how far each arm can go.'),
    item(icon(ICONS.hint, { size: 40 }), 'Hold to peek', 'Press and hold a block to see what it would claim, before you commit.'),
    item(icon(ICONS.heart, { size: 40, fill: true }), 'The Daily', 'One puzzle a day, the same for everyone, with three hearts. Each slip costs one.'),
  );
  return app.shell.sheet({ title: 'How to play', body });
}

export function openRemoveAds(app) {
  const { ads, shell } = app;
  if (ads.adsOff()) {
    return shell.sheet({
      title: 'Go ad-free',
      body: h('div.shop', null, h('p', { text: 'You already own this. Adverts are off.' })),
    });
  }
  const price = h('span', { text: '' });
  let busy = false;
  /** @type {{close: () => void}} */
  let sheet;
  const buy = button(
    'button.primary',
    {
      onclick: async () => {
        if (busy) return;
        busy = true;
        const result = await ads.buyRemoveAds();
        busy = false;
        if (result === 'purchased') {
          sheet.close();
          shell.toast('Thank you! Adverts are off for good.');
        } else if (result === 'failed') {
          shell.toast('The purchase did not go through. You have not been charged.');
        }
      },
    },
    h('span', { text: 'Remove ads' }),
    price,
  );
  ads.removeAdsPrice().then((p) => {
    if (p) price.textContent = ` · ${p}`;
  });
  const body = h(
    'div.shop',
    null,
    h('div.mascots', { 'aria-hidden': 'true' }, blockBadge(4, N | E | S | W, { size: 56 }), blockBadge(7, E | W, { size: 56 })),
    h('p', { text: 'One payment, no subscription.' }),
    h(
      'ul',
      null,
      h('li', { text: 'No banners' }),
      h('li', { text: 'No adverts between levels' }),
      h('li', { text: `${ECONOMY.hintsWithPurchase} bonus hints` }),
    ),
    h('p.fineprint', { text: 'Optional videos for extra hints stay available.' }),
    buy,
    button(
      'button.ghost',
      {
        onclick: async () => {
          if (busy) return;
          busy = true;
          const found = await ads.restorePurchases();
          busy = false;
          if (found) sheet.close();
          shell.toast(found ? 'Purchase restored. Adverts are off.' : 'No earlier purchase was found.');
        },
      },
      'Restore a purchase',
    ),
  );
  sheet = shell.sheet({ title: 'Go ad-free', body });
  return sheet;
}

/** May a missed-day streak be saved right now? (Also re-checked when the button is pressed.) */
function streakRepairDue(d, today) {
  if (!d.lastSolved || d.streak < 2) return false;
  // Exactly one day was missed, and today has not been played yet.
  if (daysBetween(d.lastSolved, today) !== 2 || d.history[today]) return false;
  // One repair a week: a streak is for playing, not for watching a video every day.
  if (d.lastRepair && daysBetween(d.lastRepair, today) < 7) return false;
  return true;
}

/** True while the offer is on screen, so it is never stacked on top of itself. */
let repairOfferOpen = false;

/**
 * Missed exactly one day? Offer to keep the streak alive.
 * The offer counts as made only once the player has answered it, so a sheet that was
 * never answered (the app was closed, no video was ready) comes back.
 * @param {any} app
 * @param {() => void} [onDone]  called after the player has answered, either way
 * @returns {boolean} whether the offer was shown
 */
export function maybeOfferStreakRepair(app, onDone) {
  const { store, ads, shell } = app;
  const d = store.state.daily;
  const today = dateKey();
  if (repairOfferOpen || d.repairOffered === today || !streakRepairDue(d, today)) return false;
  // Offer it even if no video has loaded yet (adverts are still starting when the app
  // opens): the button checks again when it is pressed.
  const free = ads.rewardMode() === 'free';

  /** @type {{close: () => void}} */
  let sheet;
  let working = false;
  const answered = () => {
    d.repairOffered = dateKey();
    store.save();
    sheet.close();
    app.refresh();
    if (onDone) onDone();
  };
  const body = h(
    'div.shop',
    null,
    h('div.big-flame', null, icon(ICONS.flame, { size: 56 })),
    h('p', { text: `You missed yesterday’s Daily. Keep your ${d.streak}-day streak going?` }),
    button(
      'button.primary',
      {
        onclick: async () => {
          if (working) return;
          // The sheet may have been left open: make sure the offer still stands.
          if (!streakRepairDue(d, dateKey())) {
            shell.toast('It is too late to save this streak.');
            answered();
            return;
          }
          if (ads.rewardMode() === 'none') {
            shell.toast('No video is available right now. Try again in a moment.');
            return;
          }
          working = true;
          const earned = await ads.watchRewarded();
          working = false;
          if (!earned) {
            shell.toast('No reward this time. The video has to play to the end.');
            return;
          }
          const now = dateKey();
          if (!streakRepairDue(d, now)) {
            answered();
            return;
          }
          const y = new Date();
          y.setDate(y.getDate() - 1);
          d.lastSolved = dateKey(y);
          d.lastRepair = now;
          shell.toast(`Streak saved. Solve today’s Daily to make it ${d.streak + 1}!`);
          answered();
        },
      },
      free ? null : icon(ICONS.video, { size: 22 }),
      free ? 'Save my streak' : 'Watch a video to save it',
    ),
    button(
      'button.ghost',
      {
        onclick: () => {
          if (!working) answered();
        },
      },
      'No thanks',
    ),
  );
  // Only the two buttons close it: a stray tap must not throw the one chance away.
  repairOfferOpen = true;
  sheet = shell.sheet({
    title: 'Save your streak?',
    body,
    dismissable: false,
    onClose: () => {
      repairOfferOpen = false;
    },
  });
  return true;
}
