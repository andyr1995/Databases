// The board on screen: draws a level and animates what the rules say happened.
// It never decides anything about the game; session.js and engine.js do that.

import { h, prefersReducedMotion } from './dom.js';
import { N, E, S, W } from './engine.js';

/** Time between one square and the next as a colour spreads. */
export const STEP_MS = 34;
/** How long a press must last before it becomes a peek instead of a tap (the usual long-press length). */
const HOLD_MS = 400;
const NS = 'http://www.w3.org/2000/svg';
export const COLOURS = 9;

const ARROW = {
  [N]: 'M50 8l14 18H36z',
  [E]: 'M92 50L74 64V36z',
  [S]: 'M50 92L36 74h28z',
  [W]: 'M8 50l18-14v28z',
};
const EDGE = '#1d1b3a';
const STEM = { [N]: 'M50 50V28', [E]: 'M50 50H72', [S]: 'M50 50V72', [W]: 'M50 50H28' };

/** The picture on a block: an arrow for each way it reaches, and a number if its reach is limited. */
export function blockSvg(dirs, len = 0) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  let stems = '';
  let heads = '';
  for (const d of [N, E, S, W]) {
    if (!(dirs & d)) continue;
    stems += STEM[d];
    heads += ARROW[d];
  }
  // Drawn twice: a dark edge underneath, then white on top. White alone is
  // close to invisible on the yellow and green blocks.
  let inner =
    `<g fill="none" stroke="${EDGE}" stroke-opacity=".5" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${stems}" stroke-width="15"/><path d="${heads}" stroke-width="6"/>` +
    `<circle cx="50" cy="50" r="${len ? 17 : 10}" stroke-width="6"/></g>` +
    `<path d="${stems}" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"/><path d="${heads}" fill="#fff"/>`;
  if (len) {
    inner +=
      `<circle cx="50" cy="50" r="17" fill="#fff"/>` +
      `<text x="50" y="51" text-anchor="middle" dominant-baseline="central" font-size="24" font-weight="800" ` +
      `font-family="ui-rounded,system-ui,sans-serif" fill="${EDGE}">${len}</text>`;
  } else {
    inner += `<circle cx="50" cy="50" r="10" fill="#fff"/>`;
  }
  svg.innerHTML = inner;
  return svg;
}

/** A small standalone block for menus and the help screen. */
export function blockBadge(colour, dirs, { len = 0, size = 48 } = {}) {
  const badge = h(`span.block-badge.k${colour % COLOURS}`, null, blockSvg(dirs, len));
  badge.style.width = `${size}px`;
  badge.style.height = `${size}px`;
  return badge;
}

const dirWords = (dirs) =>
  [dirs & N && 'up', dirs & E && 'right', dirs & S && 'down', dirs & W && 'left'].filter(Boolean).join(', ');

/**
 * @param {HTMLElement} host  element the board fills (the board keeps its proportions inside it)
 * @param {import('./engine.js').Level} level
 * @param {{onTap: (b: number) => void, onPeek: (b: number, on: boolean) => void}} handlers
 */
export function createBoard(host, level, { onTap, onPeek }) {
  const { w, h: rows } = level;
  // Start the palette somewhere different on each level, so boards do not all look alike.
  const shift = (level.w * 7 + level.h * 3 + level.squares) % COLOURS;
  const tint = (b) => (b + shift) % COLOURS;
  const reduce = () => prefersReducedMotion();
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };

  const squaresEl = h('div.layer');
  const claimsEl = h('div.layer');
  const blocksEl = h('div.layer');
  const fxEl = h('div.layer.fx');
  const el = h('div.board', null, squaresEl, claimsEl, blocksEl, fxEl);
  host.replaceChildren(el);

  const place = (node, cell) => {
    node.style.setProperty('--x', String(cell % w));
    node.style.setProperty('--y', String(Math.floor(cell / w)));
    return node;
  };

  for (let i = 0; i < level.gap.length; i++) {
    if (!level.gap[i]) squaresEl.append(place(h('div.at.sq'), i));
  }

  /** @type {HTMLButtonElement[]} */
  const blockEls = level.blocks.map((block, b) => {
    const btn = /** @type {HTMLButtonElement} */ (
      h(
        `button.at.block.k${tint(b)}`,
        {
          type: 'button',
          'data-b': String(b),
          'aria-label': `Block ${b + 1}, reaches ${dirWords(block.dirs)}${block.len ? `, ${block.len} squares` : ''}`,
        },
        h('span.face', null, blockSvg(block.dirs, block.len)),
      )
    );
    blocksEl.append(place(btn, block.cell));
    return btn;
  });

  function layout() {
    const availW = host.clientWidth;
    const availH = host.clientHeight;
    if (!availW || !availH) return;
    const cell = Math.max(26, Math.min(78, Math.floor(Math.min(availW / w, availH / rows))));
    el.style.setProperty('--cell', `${cell}px`);
    el.style.width = `${w * cell}px`;
    el.style.height = `${rows * cell}px`;
  }
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(layout) : null;
  if (observer) observer.observe(host);
  else window.addEventListener('resize', layout);

  const axisOf = (b, cell) => (Math.floor(cell / w) === Math.floor(level.blocks[b].cell / w) ? 'h' : 'v');

  function claimEl(b, cell, extra = '') {
    return place(h(`div.at.claim.k${tint(b)}.${axisOf(b, cell)}${extra}`), cell);
  }

  /** Draw a position with no animation (start, restart, carrying on a saved level). */
  function reset(pos) {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    claimsEl.replaceChildren();
    fxEl.replaceChildren();
    el.classList.remove('won', 'shake');
    for (let i = 0; i < pos.owner.length; i++) {
      if (pos.owner[i] >= 0) claimsEl.append(claimEl(pos.owner[i], i, '.still'));
    }
    blockEls.forEach((btn, b) => {
      btn.classList.toggle('done', !!(pos.done & (1 << b)));
      btn.classList.remove('hinted', 'oops', 'pop');
      btn.disabled = !!(pos.done & (1 << b));
    });
  }

  const longest = (sent) => sent.reduce((m, arm) => Math.max(m, arm.cells.length), 0);

  /** A good tap: the colour runs out along each arrow and stays. */
  function claim(b, sent) {
    clearHint();
    const step = reduce() ? 0 : STEP_MS;
    for (const arm of sent) {
      arm.cells.forEach((cell, i) => {
        const node = claimEl(b, cell);
        node.style.setProperty('--delay', `${i * step}ms`);
        claimsEl.append(node);
      });
    }
    markDone(b);
    const steps = longest(sent);
    return { steps, duration: steps * step + 200 };
  }

  /** A block that has gone (or had nowhere to go). */
  function markDone(b) {
    const btn = blockEls[b];
    btn.classList.add('done', 'pop');
    btn.classList.remove('hinted');
    btn.disabled = true;
    later(() => btn.classList.remove('pop'), 320);
  }

  /**
   * A wrong tap: the colour runs out, the squares it would leave bare are
   * crossed, and then everything is pulled back.
   */
  function slip(b, sent, stranded) {
    clearHint();
    const step = reduce() ? 0 : STEP_MS;
    const steps = longest(sent);
    const nodes = [];
    for (const arm of sent) {
      arm.cells.forEach((cell, i) => {
        const node = claimEl(b, cell, '.ghosted');
        node.style.setProperty('--delay', `${i * step}ms`);
        node.style.setProperty('--back', `${(arm.cells.length - 1 - i) * Math.round(step * 0.6)}ms`);
        claimsEl.append(node);
        nodes.push(node);
      });
    }
    const btn = blockEls[b];
    btn.classList.add('oops');
    const out = steps * step + 140;
    const hold = 700;
    const back = Math.round(steps * step * 0.6) + 200;
    later(() => {
      el.classList.add('shake');
      for (const cell of stranded) fxEl.append(place(h('div.at.cross'), cell));
    }, out);
    later(() => {
      for (const node of nodes) node.classList.add('retract');
      for (const cross of fxEl.querySelectorAll('.cross')) cross.classList.add('out');
    }, out + hold);
    later(() => {
      for (const node of nodes) node.remove();
      for (const cross of fxEl.querySelectorAll('.cross')) cross.remove();
      btn.classList.remove('oops');
      el.classList.remove('shake');
    }, out + hold + back);
    return { duration: out + hold + back };
  }

  function peek(b, sent) {
    unpeek();
    for (const arm of sent) {
      arm.cells.forEach((cell, i) => {
        const node = place(h(`div.at.peekcell.k${tint(b)}`), cell);
        node.style.setProperty('--delay', `${i * 14}ms`);
        fxEl.append(node);
      });
    }
    blockEls[b].classList.add('peeking');
  }
  function unpeek() {
    for (const node of fxEl.querySelectorAll('.peekcell')) node.remove();
    for (const btn of blockEls) btn.classList.remove('peeking');
  }

  function clearHint() {
    for (const btn of blockEls) btn.classList.remove('hinted');
  }
  function hint(b) {
    clearHint();
    blockEls[b].classList.add('hinted');
  }

  /** Board filled: a wave runs across it, with confetti for a flawless solve. */
  function celebrate({ flawless = false, spare = [] } = {}) {
    for (const b of spare) markDone(b);
    for (const node of [...claimsEl.children, ...blocksEl.children]) {
      const x = Number(/** @type {HTMLElement} */ (node).style.getPropertyValue('--x'));
      const y = Number(/** @type {HTMLElement} */ (node).style.getPropertyValue('--y'));
      /** @type {HTMLElement} */ (node).style.setProperty('--wave', `${(x + y) * 45}ms`);
    }
    el.classList.add('won');
    if (!flawless || reduce()) return;
    const tints = ['#ff5a6e', '#ffb020', '#ffe45c', '#7ee04f', '#19c9a4', '#45b6ff', '#b06cff'];
    const confetti = h('div.confetti');
    for (let k = 0; k < 30; k++) {
      const bit = h('span');
      bit.style.setProperty('--px', `${(k * 37) % 100}%`);
      bit.style.setProperty('--d', `${(k % 7) * 60}ms`);
      bit.style.setProperty('--r', `${(k * 53) % 360}deg`);
      bit.style.setProperty('--drift', `${((k * 29) % 70) - 35}px`);
      bit.style.background = tints[k % tints.length];
      confetti.append(bit);
    }
    fxEl.append(confetti);
    later(() => confetti.remove(), 2300);
  }

  // ---- input: tap to go, hold to peek ----
  // Each finger is tracked on its own, so two thumbs can play at once.
  /** @type {Map<number, {b: number, peeked: boolean, timer: any}>} */
  const presses = new Map();
  const blockOf = (target) => {
    const btn = target instanceof Element ? target.closest('.block') : null;
    return btn && !(/** @type {HTMLButtonElement} */ (btn).disabled) ? Number(btn.getAttribute('data-b')) : -1;
  };
  const release = (id) => {
    const press = presses.get(id);
    if (!press) return null;
    presses.delete(id);
    clearTimeout(press.timer);
    if (press.peeked) onPeek(press.b, false);
    return press;
  };
  const releaseAll = () => {
    for (const id of [...presses.keys()]) release(id);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const b = blockOf(e.target);
    if (b < 0) return;
    release(e.pointerId);
    const press = { b, peeked: false, timer: 0 };
    press.timer = setTimeout(() => {
      if (presses.get(e.pointerId) !== press) return;
      press.peeked = true;
      onPeek(b, true);
    }, HOLD_MS);
    presses.set(e.pointerId, press);
  });
  el.addEventListener('pointerup', (e) => {
    const press = release(e.pointerId);
    if (press && !press.peeked && blockOf(document.elementFromPoint(e.clientX, e.clientY)) === press.b) onTap(press.b);
  });
  el.addEventListener('pointercancel', (e) => release(e.pointerId));
  el.addEventListener('pointerleave', (e) => release(e.pointerId));
  // Keyboard and switch access: Enter or Space on a focused block.
  el.addEventListener('click', (e) => {
    if (e.detail !== 0) return;
    const b = blockOf(e.target);
    if (b < 0) return;
    onTap(b);
    // If the block went, it is now disabled: keep the keyboard on the board.
    if (blockEls[b].disabled) {
      const next = blockEls.find((btn) => !btn.disabled);
      if (next) next.focus();
    }
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  layout();

  return {
    el,
    reset,
    claim,
    markDone,
    slip,
    peek,
    unpeek,
    hint,
    clearHint,
    celebrate,
    layout,
    /** Colour number (0..8) a block is drawn in. */
    tint,
    destroy() {
      for (const id of timers) clearTimeout(id);
      timers.clear();
      releaseAll();
      if (observer) observer.disconnect();
      else window.removeEventListener('resize', layout);
      el.remove();
    },
  };
}
