// The play screen: one level, its HUD, and what happens when it is won or lost.

import { h, icon, ICONS } from './dom.js';
import { button } from './shell.js';
import { createBoard, STEP_MS } from './board.js';
import { createSession } from './session.js';
import { campaignLevel, dailyLevel, featuresOf } from './levels.js';
import { starsFor } from './engine.js';
import { dateKey, dailyNumber, applyDailySolve, liveStreak, msUntilTomorrow, formatCountdown } from './dates.js';
import { sfx } from './sfx.js';
import { unlockAudio } from './synth.js';
import { dailyShare, packStory, unpackStory } from './share.js';
import { ECONOMY } from './config.js';

const OPENING_TIPS = {
  1: 'Tap the block',
  2: 'A block claims every square in its path',
  3: 'Order matters. Who should go first?',
  4: 'Hold a block to peek at its reach',
};
const FEATURE_TIPS = {
  arrows: 'The arrows show which ways a block reaches.',
  short: 'A number is how far each arm can reach.',
};
const SLIP_TIP = 'That would leave squares nobody can reach. Try another order.';
const DAY_FORMAT = { weekday: 'short', day: 'numeric', month: 'short' };

/**
 * @param {any} app  the app context from main.js
 * @param {{mode: 'campaign'|'daily', level?: number}} opts
 */
export function gameScreen(app, { mode, level: startAt }) {
  const { store, ads, shell } = app;
  const today = dateKey();
  const daily = mode === 'daily';

  /** @type {import('./engine.js').Level} */
  let level;
  let levelNo = startAt || store.state.level;
  /** @type {ReturnType<typeof createSession>} */
  let session;
  /** @type {ReturnType<typeof createBoard> | null} */
  let board = null;
  let hintsUsed = 0;
  /** Extra hearts earned today (Daily only). */
  let extraHearts = 0;
  /** How many taps had been made when the current hint was paid for, so asking again is free. */
  let hintPaidAt = -1;
  let busy = false;
  let destroyed = false;
  let countdownTimer = null;
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!destroyed) fn();
    }, ms);
    timers.add(id);
  };

  // ---- layout ----
  const titleEl = h('div.title');
  const subtitleEl = h('div.subtitle');
  const leftEl = h('b', { text: '0' });
  const slipsEl = h('b', { text: '0' });
  const meterEl = h('div.meter', { 'aria-hidden': 'true' });
  const coachEl = h('div.coach', { 'aria-live': 'polite' });
  const boardHost = h('div.board-host');
  const hintBadge = h('span.badge');

  const hintBtn = button(
    'button.tool.hint-btn',
    { 'aria-label': 'Hint', onclick: onHint },
    icon(ICONS.hint, { size: 26 }),
    h('span', { text: 'Hint' }),
    hintBadge,
  );
  const restartBtn = button(
    'button.tool',
    { 'aria-label': 'Restart', onclick: onRestart },
    icon(ICONS.restart, { size: 26 }),
    h('span', { text: 'Restart' }),
  );
  const helpBtn = button(
    'button.tool',
    { 'aria-label': 'How to play', onclick: () => app.openHelp() },
    icon(ICONS.help, { size: 26 }),
    h('span', { text: 'Rules' }),
  );

  const el = h(
    `section.screen.game${daily ? '.is-daily' : ''}`,
    null,
    h(
      'header.topbar',
      null,
      button('button.icon-btn', { 'aria-label': 'Home', onclick: () => app.goHome() }, icon(ICONS.back)),
      h('div.titles', null, titleEl, subtitleEl),
      button('button.icon-btn', { 'aria-label': 'Settings', onclick: () => app.openSettings() }, icon(ICONS.gear)),
    ),
    h(
      'div.hud',
      null,
      h('div.stat', null, h('span', { text: 'Blocks left' }), leftEl),
      meterEl,
      h('div.stat', null, h('span', { text: 'Slips' }), slipsEl),
    ),
    coachEl,
    boardHost,
    h('footer.tools', null, hintBtn, daily ? helpBtn : restartBtn),
  );

  // ---- helpers ----
  const resumeId = () => (daily ? today : levelNo);

  function saveResume() {
    store.state.resume[mode] = session.taps.length
      ? { id: resumeId(), taps: session.taps.slice(), hints: hintsUsed, extra: extraHearts }
      : null;
    store.save();
  }

  function setCoach(text) {
    coachEl.textContent = text || '';
    coachEl.classList.toggle('show', !!text);
  }

  function updateHud() {
    leftEl.textContent = String(session.remaining);
    slipsEl.textContent = String(session.slips);
    meterEl.replaceChildren();
    if (daily) {
      const total = 3 + extraHearts;
      for (let i = 0; i < total; i++) {
        meterEl.append(h(`span.heart${i < session.heartsLeft ? '.on' : ''}`, null, icon(ICONS.heart, { size: 26, fill: true })));
      }
    } else {
      const potential = starsFor(session.slips);
      for (let i = 0; i < 3; i++) {
        meterEl.append(h(`span.star${i < potential ? '.on' : ''}`, null, icon(ICONS.star, { size: 26, fill: true })));
      }
    }
    const over = session.solved || session.lost;
    hintBtn.disabled = over;
    restartBtn.disabled = over || session.taps.length === 0;
    updateHintBadge();
  }

  function updateHintBadge() {
    const n = store.state.hints;
    hintBadge.replaceChildren();
    if (n > 0) {
      hintBadge.className = 'badge';
      hintBadge.textContent = String(n);
    } else if (ads.rewardMode() === 'free') {
      hintBadge.className = 'badge hidden';
    } else {
      hintBadge.className = 'badge video';
      hintBadge.append(icon(ICONS.video, { size: 14 }));
    }
  }

  function load(n) {
    levelNo = n;
    level = daily ? dailyLevel(today) : campaignLevel(levelNo);
    const saved = store.state.resume[mode];
    const mine = saved && saved.id === resumeId() && Array.isArray(saved.taps);
    const finished = daily ? store.state.daily.history[today] : null;
    let taps = [];
    hintsUsed = 0;
    extraHearts = 0;
    if (finished) {
      taps = Array.from(finished.taps || '', (ch) => parseInt(ch, 36));
      hintsUsed = finished.hints || 0;
      extraHearts = finished.extra || 0;
    } else if (mine) {
      taps = saved.taps;
      hintsUsed = saved.hints || 0;
      extraHearts = daily ? saved.extra || 0 : 0;
    }
    hintPaidAt = -1;
    busy = false;
    session = createSession(level, { taps, hearts: daily ? 3 + extraHearts : Infinity });

    if (board) board.destroy();
    board = createBoard(boardHost, level, { onTap, onPeek });
    board.reset(session.position);

    if (daily) {
      titleEl.textContent = `Daily #${dailyNumber(today)}`;
      subtitleEl.textContent = new Date().toLocaleDateString(undefined, DAY_FORMAT);
    } else {
      titleEl.textContent = `Level ${levelNo}`;
      subtitleEl.textContent = '';
    }
    updateHud();
    showTips();
    if (!daily) later(() => campaignLevel(levelNo + 1), 1500);

    if (finished) {
      busy = true;
      later(() => showResult({ won: !!finished.won, slips: finished.slips, story: unpackStory(finished.story), again: true }), 350);
    } else if (session.lost) {
      busy = true;
      later(offerHeart, 350);
    }
  }

  function showTips() {
    setCoach('');
    if (session.taps.length > 0 || session.solved) return;
    const seen = store.state.seen;
    if (!daily && OPENING_TIPS[levelNo] && !store.state.stars[levelNo]) {
      setCoach(OPENING_TIPS[levelNo]);
      if (levelNo === 1) board.hint(0);
      return;
    }
    const features = featuresOf(level);
    const tips = [
      ['arrows', features.lines || features.bends],
      ['short', features.short],
    ];
    for (const [key, present] of tips) {
      if (present && !seen[key]) {
        seen[key] = true;
        store.save();
        setCoach(FEATURE_TIPS[key]);
        return;
      }
    }
  }

  // ---- play ----
  function onPeek(b, on) {
    if (!on) {
      board.unpeek();
      return;
    }
    if (busy || destroyed || shell.sheetOpen()) return;
    const sent = session.peek(b);
    if (!sent.length) return;
    unlockAudio();
    sfx.peek();
    app.haptic('tap');
    board.peek(b, sent);
  }

  function onTap(b) {
    if (busy || destroyed || shell.sheetOpen()) return;
    unlockAudio();
    const result = session.tap(b);
    if (!result) return;
    board.unpeek();
    hintPaidAt = -1;

    if (result.kind === 'empty') {
      board.markDone(b);
      sfx.dud();
      saveResume();
      updateHud();
      return;
    }

    if (result.kind === 'slip') {
      busy = true;
      const timing = board.slip(b, result.arms, result.stranded);
      sfx.slip();
      app.haptic('error');
      setCoach(SLIP_TIP);
      saveResume();
      updateHud();
      later(() => {
        if (result.lost) {
          offerHeart();
        } else {
          busy = false;
        }
      }, timing.duration);
      return;
    }

    setCoach('');
    const timing = board.claim(b, result.arms);
    sfx.claim(board.tint(b), timing.steps, STEP_MS);
    app.haptic('soft');
    saveResume();
    updateHud();
    if (result.solved) onSolved(timing.duration, result.spare);
  }

  function onRestart() {
    if (daily || busy || session.taps.length === 0) return;
    sfx.restart();
    session.restart();
    hintPaidAt = -1;
    hintsUsed = 0;
    busy = false;
    board.reset(session.position);
    saveResume();
    updateHud();
    setCoach('');
  }

  /**
   * Spend a hint token, or earn the reward another way.
   * @returns {Promise<boolean>} whether the player may have the reward
   */
  async function payForHelp(whatFor) {
    if (store.state.hints > 0 && whatFor === 'hint') {
      store.state.hints--;
      store.save();
      return true;
    }
    const how = ads.rewardMode();
    if (how === 'none') {
      shell.toast('No video is available right now. Try again in a moment.');
      return false;
    }
    if (how === 'ad') {
      const earned = await ads.watchRewarded();
      if (!earned) shell.toast(`Watch the whole video to get your ${whatFor}.`);
      return earned;
    }
    return true;
  }

  async function onHint() {
    if (busy || session.solved || session.lost) return;
    const safe = session.hint();
    if (safe < 0) return;
    if (hintPaidAt !== session.taps.length) {
      busy = true;
      const ok = await payForHelp('hint');
      busy = false;
      if (destroyed || !ok) return;
      hintPaidAt = session.taps.length;
      hintsUsed++;
      store.state.stats.hintsUsed++;
      saveResume();
    }
    sfx.hint();
    board.hint(safe);
    updateHud();
  }

  // ---- the Daily's hearts ----
  function offerHeart() {
    busy = true;
    if (extraHearts > 0) {
      finishLost();
      return;
    }
    const how = ads.rewardMode();
    /** @type {{close: () => void}} */
    let sheet;
    let choosing = false;
    const body = [
      h('div.big-heart.broken', null, icon(ICONS.heart, { size: 60, fill: true })),
      h('h2.result-title', { text: 'Out of hearts' }),
      h('p.result-detail', { text: 'One more heart lets you carry on from here.' }),
      button(
        'button.primary',
        {
          onclick: async () => {
            if (choosing) return;
            choosing = true;
            const ok = await payForHelp('heart');
            choosing = false;
            if (destroyed || !ok) return;
            extraHearts = 1;
            session.addHeart();
            saveResume();
            sheet.close();
            busy = false;
            updateHud();
            setCoach('One more heart. Take your time.');
          },
        },
        how === 'free' ? icon(ICONS.heart, { size: 22, fill: true }) : icon(ICONS.video, { size: 22 }),
        how === 'free' ? 'One more heart' : 'Watch a video for a heart',
      ),
      button(
        'button.ghost',
        {
          onclick: () => {
            if (choosing) return;
            sheet.close();
            finishLost();
          },
        },
        'Give up for today',
      ),
    ];
    sfx.lose();
    sheet = shell.sheet({ body, dismissable: false, className: 'result' });
  }

  function recordDaily(won) {
    const s = store.state;
    const d = s.daily;
    let earnedHint = false;
    if (!d.history[today]) {
      d.history[today] = {
        won,
        slips: session.slips,
        stars: won ? session.stars : 0,
        hints: hintsUsed,
        extra: extraHearts,
        story: packStory(session.story),
        taps: session.taps.map((b) => b.toString(36)).join(''),
      };
      if (won) {
        Object.assign(d, applyDailySolve(d, today));
        s.stats.dailies++;
        s.hints += ECONOMY.hintsPerDaily;
        earnedHint = true;
      }
      // Keep the last two months; older days are only ever shown as a count.
      const keys = Object.keys(d.history).sort();
      while (keys.length > 62) delete d.history[keys.shift()];
    }
    s.resume.daily = null;
    store.save();
    return earnedHint;
  }

  function finishLost() {
    busy = true;
    recordDaily(false);
    updateHud();
    showResult({ won: false, slips: session.slips, story: session.story });
  }

  // ---- winning ----
  function recordCampaign() {
    const s = store.state;
    const stars = session.stars;
    let earnedHint = false;
    const before = s.stars[levelNo] || 0;
    if (!before) {
      s.stats.solved++;
      if (levelNo >= s.level) s.level = levelNo + 1;
      if (s.stats.solved % ECONOMY.hintEveryLevels === 0) {
        s.hints++;
        earnedHint = true;
      }
    }
    if (stars === 3 && before < 3) s.stats.perfect++;
    if (stars > before) s.stars[levelNo] = stars;
    ads.levelCompleted();
    s.resume.campaign = null;
    store.save();
    return earnedHint;
  }

  function onSolved(afterMs, spare) {
    busy = true;
    const earnedHint = daily ? recordDaily(true) : recordCampaign();
    const flawless = session.slips === 0;
    updateHud();
    later(() => {
      board.celebrate({ flawless, spare });
      sfx.win();
      app.haptic('success');
    }, afterMs + 80);
    later(() => showResult({ won: true, slips: session.slips, story: session.story, earnedHint }), afterMs + 1250);
  }

  function showResult({ won, slips, story, earnedHint = false, again = false }) {
    const stars = won ? starsFor(slips) : 0;
    const body = [];
    if (won) {
      body.push(
        h(
          'div.result-stars',
          { 'aria-label': `${stars} of 3 stars` },
          [0, 1, 2].map((i) =>
            h(`span.star${i < stars ? '.on' : ''}`, { style: { '--i': String(i) } }, icon(ICONS.star, { size: 54, fill: true })),
          ),
        ),
      );
      if (!again) for (let i = 0; i < stars; i++) later(() => sfx.star(i), 260 + i * 220);
    } else {
      body.push(h('div.big-heart.broken', null, icon(ICONS.heart, { size: 60, fill: true })));
    }
    const headline = !won
      ? 'Not today'
      : daily
        ? again
          ? 'Solved today'
          : slips === 0
            ? 'Flawless Daily!'
            : 'Daily solved!'
        : slips === 0
          ? 'Flawless!'
          : 'Solved!';
    const slipText = slips === 0 ? 'no slips' : `${slips} ${slips === 1 ? 'slip' : 'slips'}`;
    const count = level.blocks.length;
    const detail = won ? `${count} ${count === 1 ? 'block' : 'blocks'} · ${slipText}` : 'A new puzzle arrives at midnight.';
    body.push(h('h2.result-title', { text: headline }), h('p.result-detail', { text: detail }));
    if (earnedHint) body.push(h('div.chip', null, icon(ICONS.hint, { size: 18 }), '+1 hint'));

    /** @type {{close: () => void}} */
    let sheet;
    const leave = (fn) => {
      clearInterval(countdownTimer);
      sheet.close();
      fn();
    };

    if (daily) {
      const streak = liveStreak(store.state.daily, today);
      body.push(
        h(
          'div.story',
          { 'aria-label': 'Your solve, tap by tap' },
          story.map((good) => h(`span${good ? '.hit' : '.miss'}`)),
        ),
      );
      if (won && streak >= 1) body.push(h('div.streak', null, icon(ICONS.flame, { size: 22 }), `${streak}-day streak`));
      const countdown = h('p.countdown');
      const tick = () => {
        countdown.textContent = `Next puzzle in ${formatCountdown(msUntilTomorrow())}`;
      };
      tick();
      clearInterval(countdownTimer);
      countdownTimer = setInterval(tick, 1000);
      body.push(
        button(
          'button.primary',
          {
            onclick: async () => {
              const outcome = await app.platform.share(
                dailyShare({ number: dailyNumber(today), story, won, slips, stars, streak: won ? streak : 0 }),
              );
              if (outcome === 'copied') shell.toast('Copied. Paste it to a friend!');
              else if (outcome === 'failed') shell.toast('Sharing is not available here.');
            },
          },
          icon(ICONS.share, { size: 22 }),
          'Share',
        ),
        countdown,
        button('button.ghost', { onclick: () => leave(() => app.goHome()) }, 'Home'),
      );
    } else {
      let going = false;
      body.push(
        button(
          'button.primary',
          {
            onclick: async () => {
              if (going) return;
              going = true;
              sheet.close();
              await ads.interstitialIfDue();
              if (!destroyed) load(levelNo + 1);
            },
          },
          'Next level',
          icon(ICONS.next, { size: 22 }),
        ),
      );
      if (stars < 3) {
        body.push(button('button.secondary', { onclick: () => leave(() => load(levelNo)) }, 'Try for 3 stars'));
      }
      body.push(button('button.ghost', { onclick: () => leave(() => app.goHome()) }, 'Home'));
    }
    sheet = shell.sheet({ body, dismissable: false, className: 'result' });
  }

  // The Daily keeps adverts at arm's length: no banner, no full-screen adverts.
  ads.setBanner(!daily);
  load(levelNo);

  return {
    el,
    /** Other parts of the app changed something the HUD shows (hints, adverts). */
    refresh: updateHud,
    destroy() {
      destroyed = true;
      for (const id of timers) clearTimeout(id);
      clearInterval(countdownTimer);
      ads.setBanner(false);
      if (board) board.destroy();
    },
  };
}
