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
  if (ads.removeAdsAvailable()) {
    if (!ads.adsOff()) rows.push(linkRow('Remove ads', () => app.openRemoveAds()));
    rows.push(
      linkRow('Restore purchases', async () => {
        const found = await ads.restorePurchases();
        shell.toast(found ? 'Purchase restored. Adverts are off.' : 'No earlier purchase was found.');
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
  return shell.sheet({ title: 'Settings', body: h('div.rows', null, rows) });
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
          const found = await ads.restorePurchases();
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

/**
 * Missed exactly one day? Offer to keep the streak alive, once.
 * @returns {boolean} whether the offer was shown
 */
export function maybeOfferStreakRepair(app) {
  const { store, ads, shell } = app;
  const d = store.state.daily;
  const today = dateKey();
  if (!d.lastSolved || d.streak < 2 || d.repairOffered === today) return false;
  if (daysBetween(d.lastSolved, today) !== 2) return false;
  // Offer it even if no video has loaded yet (adverts are still starting when the app
  // opens): the button checks again when it is pressed.
  const free = ads.rewardMode() === 'free';

  d.repairOffered = today;
  store.save();
  /** @type {{close: () => void}} */
  let sheet;
  const body = h(
    'div.shop',
    null,
    h('div.big-flame', null, icon(ICONS.flame, { size: 56 })),
    h('p', { text: `You missed yesterday’s Daily. Keep your ${d.streak}-day streak going?` }),
    button(
      'button.primary',
      {
        onclick: async () => {
          if (ads.rewardMode() === 'none') {
            shell.toast('No video is available right now. Try again in a moment.');
            return;
          }
          const earned = await ads.watchRewarded();
          if (!earned) {
            shell.toast('Watch the whole video to save your streak.');
            return;
          }
          const y = new Date();
          y.setDate(y.getDate() - 1);
          d.lastSolved = dateKey(y);
          store.save();
          sheet.close();
          shell.toast(`Streak saved. Solve today’s Daily to make it ${d.streak + 1}!`);
          app.refresh();
        },
      },
      free ? null : icon(ICONS.video, { size: 22 }),
      free ? 'Save my streak' : 'Watch a video to save it',
    ),
    button('button.ghost', { onclick: () => sheet.close() }, 'No thanks'),
  );
  sheet = shell.sheet({ title: 'Save your streak?', body });
  return true;
}
