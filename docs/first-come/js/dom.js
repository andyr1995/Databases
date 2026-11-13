// Small DOM helpers. The whole interface is plain DOM; there is no framework to load.

/**
 * Create an element.
 * @param {string} tag  e.g. 'button.primary.big' (classes after dots)
 * @param {Record<string, any>|null} [props]  attributes; `on*` keys add listeners; `text` sets textContent; `html` sets innerHTML
 * @param {...(Node|string|null|false|undefined|Array<Node|string|null|false|undefined>)} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Inline SVG icon from a path string, drawn on a 24x24 grid. */
export function icon(d, { size = 24, fill = false } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  if (fill) {
    path.setAttribute('fill', 'currentColor');
  } else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.appendChild(path);
  return svg;
}

export const ICONS = {
  back: 'M15 5l-7 7 7 7',
  close: 'M6 6l12 12M18 6L6 18',
  undo: 'M9 7L4 12l5 5M4 12h10a6 6 0 010 12h-2',
  restart: 'M4 12a8 8 0 108-8H7M7 4L4 7l3 3',
  hint: 'M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0012 3z',
  gear: 'M12 9a3 3 0 100 6 3 3 0 000-6zM19 12a7 7 0 00-.1-1.3l2-1.5-2-3.4-2.3.9a7 7 0 00-2.2-1.3L14 3h-4l-.4 2.4a7 7 0 00-2.2 1.3l-2.3-.9-2 3.4 2 1.5a7 7 0 000 2.6l-2 1.5 2 3.4 2.3-.9a7 7 0 002.2 1.3L10 21h4l.4-2.4a7 7 0 002.2-1.3l2.3.9 2-3.4-2-1.5c.1-.4.1-.9.1-1.3z',
  share: 'M12 3v12M8 7l4-4 4 4M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6',
  stats: 'M5 20V11M12 20V4M19 20v-6',
  play: 'M8 5l11 7-11 7z',
  video: 'M4 7a2 2 0 012-2h8a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2zM16 10l5-3v10l-5-3',
  calendar: 'M5 6h14a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1zM4 10h16M8 3v4M16 3v4',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  flame: 'M12 3c1 3 4 4.5 4 9a4 4 0 01-8 0c0-1.5.5-2.5 1-3.5C9.5 6.5 11 5.5 12 3zM12 21a7 7 0 007-7',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8-4.3-4.1 5.9-.8z',
  noads: 'M4 4l16 16M7 5h10a2 2 0 012 2v10M17 19H7a2 2 0 01-2-2V7',
  help: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.6 9.6a2.5 2.5 0 114 2c-1 .7-1.6 1.3-1.6 2.4M12 17.2v.1',
  next: 'M9 5l7 7-7 7',
  heart: 'M12 20.7C6.2 16.2 3.2 12.9 3.2 9.1c0-2.6 2-4.6 4.5-4.6 1.7 0 3.3.9 4.3 2.4 1-1.5 2.6-2.4 4.3-2.4 2.5 0 4.5 2 4.5 4.6 0 3.8-3 7.1-8.8 11.6z',
};

/** Wait for a number of milliseconds. */
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** True if the player has asked the system for less motion. */
export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
