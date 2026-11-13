// The front door: carry on the campaign, play today's Daily, and the small print.

import { h, icon, ICONS } from './dom.js';
import { button } from './shell.js';
import { blockBadge } from './board.js';
import { N, E, S, W } from './engine.js';
import { dateKey, dailyLabelNumber, liveStreak, msUntilTomorrow, formatCountdown } from './dates.js';
import { prepareCampaignLevel } from './levels.js';
import { APP } from './config.js';

export function homeScreen(app) {
  const { store, ads } = app;
  let timer = null;

  const playLabel = h('span.big');
  const playSub = h('span.small');
  const dailyState = h('span.small');
  const dailyTitle = h('span.big');
  const streakEl = h('span.streak-pill');
  const noAdsBtn = button(
    'button.pill',
    { onclick: () => app.openRemoveAds() },
    icon(ICONS.noads, { size: 20 }),
    h('span', { text: 'Remove ads' }),
  );

  const el = h(
    'section.screen.home',
    null,
    h(
      'div.hero',
      null,
      h(
        'div.mascots',
        { 'aria-hidden': 'true' },
        blockBadge(5, E | W, { size: 58 }),
        blockBadge(0, N | E | S | W, { size: 78 }),
        blockBadge(2, N | E, { size: 58 }),
      ),
      h('h1.logo', { text: APP.name }),
      h('p.tagline', { text: APP.tagline }),
    ),
    h(
      'div.menu',
      null,
      button(
        'button.primary.play',
        { onclick: () => app.play('campaign') },
        icon(ICONS.play, { size: 26, fill: true }),
        h('span.labels', null, playLabel, playSub),
      ),
      button(
        'button.card.daily',
        { onclick: () => app.play('daily') },
        h('span.cal', null, icon(ICONS.calendar, { size: 26 })),
        h('span.labels', null, dailyTitle, dailyState),
        streakEl,
      ),
    ),
    h(
      'div.links',
      null,
      button('button.pill', { onclick: () => app.openStats() }, icon(ICONS.stats, { size: 20 }), h('span', { text: 'Stats' })),
      button('button.pill', { onclick: () => app.openHelp() }, icon(ICONS.help, { size: 20 }), h('span', { text: 'How to play' })),
      button('button.pill', { onclick: () => app.openSettings() }, icon(ICONS.gear, { size: 20 }), h('span', { text: 'Settings' })),
      noAdsBtn,
    ),
  );

  function refresh() {
    const s = store.state;
    const today = dateKey();
    const stars = Object.values(s.stars).reduce((a, b) => a + b, 0);
    playLabel.textContent = s.stats.solved === 0 && !s.resume.campaign ? 'Play' : `Level ${s.level}`;
    playSub.textContent = stars > 0 ? `${stars} ${stars === 1 ? 'star' : 'stars'} collected` : 'Start here';

    const done = s.daily.history[today];
    dailyTitle.textContent = `Daily #${dailyLabelNumber(today)}`;
    if (done) {
      const mark = done.won ? '★'.repeat(done.stars) : 'Out of hearts';
      dailyState.textContent = `${mark} · next in ${formatCountdown(msUntilTomorrow(), { seconds: false })}`;
    } else {
      dailyState.textContent =
        s.resume.daily && s.resume.daily.id === today ? 'Carry on today’s puzzle' : 'One puzzle a day, the same for everyone';
    }
    const streak = liveStreak(s.daily, today);
    streakEl.replaceChildren();
    streakEl.classList.toggle('hidden', streak < 1);
    if (streak >= 1) streakEl.append(icon(ICONS.flame, { size: 18 }), String(streak));

    noAdsBtn.classList.toggle('hidden', !ads.removeAdsAvailable() || ads.adsOff());
  }

  refresh();
  timer = setInterval(refresh, 15000);
  // Far into the game the next level has to be built first; start now so Play is instant.
  prepareCampaignLevel(store.state.level);

  return {
    el,
    refresh,
    destroy() {
      clearInterval(timer);
    },
  };
}
