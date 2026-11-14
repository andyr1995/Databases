// The app frame: one screen at a time, bottom sheets on top, and toasts.

import { h, icon, ICONS } from './dom.js';
import { sfx } from './sfx.js';
import { unlockAudio } from './synth.js';

/**
 * @param {HTMLElement} root
 */
export function createShell(root) {
  const screenHost = h('div.screen-host');
  const sheetHost = h('div.sheet-host');
  const toastHost = h('div.toast-host', { 'aria-live': 'polite' });
  root.replaceChildren(screenHost, sheetHost, toastHost);

  /** @type {{el: HTMLElement, destroy?: () => void} | null} */
  let current = null;
  let toastTimer = null;
  /** @type {Array<{close: () => void, dismissable?: boolean, restoreFocus?: () => void}>} */
  const sheets = [];

  // Escape closes the top sheet, if it is one that may be dismissed.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !sheets.length) return;
    const top = sheets[sheets.length - 1];
    if (top.dismissable) top.close();
  });

  return {
    /** Replace the visible screen. */
    show(screen) {
      while (sheets.length) sheets[sheets.length - 1].close();
      if (current && current.destroy) current.destroy();
      current = screen;
      screenHost.replaceChildren(screen.el);
    },

    /** A short message that fades away. */
    toast(text, ms = 2600) {
      clearTimeout(toastTimer);
      const el = h('div.toast', { text });
      toastHost.replaceChildren(el);
      toastTimer = setTimeout(() => {
        el.classList.add('out');
        setTimeout(() => el.remove(), 300);
      }, ms);
    },

    /**
     * A panel that slides up from the bottom.
     * @param {{title?: string, body: Node|Node[], dismissable?: boolean, onClose?: () => void, className?: string}} o
     * @returns {{close: () => void, el: HTMLElement}}
     */
    sheet({ title, body, dismissable = true, onClose, className = '' }) {
      let closed = false;
      const panel = h(`div.sheet${className ? '.' + className : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' });
      const backdrop = h('div.backdrop');
      const wrap = h('div.sheet-wrap', null, backdrop, panel);

      /** @type {{el: HTMLElement, close: () => void, dismissable?: boolean, restoreFocus?: () => void}} */
      const handle = {
        el: panel,
        close() {
          if (closed) return;
          closed = true;
          const i = sheets.indexOf(handle);
          if (i >= 0) sheets.splice(i, 1);
          wrap.classList.add('out');
          setTimeout(() => wrap.remove(), 220);
          if (handle.restoreFocus) handle.restoreFocus();
          if (onClose) onClose();
        },
      };

      if (title || dismissable) {
        panel.append(
          h(
            'div.sheet-head',
            null,
            h('h2', { text: title || '' }),
            dismissable &&
              h(
                'button.icon-btn',
                {
                  'aria-label': 'Close',
                  onclick: () => {
                    sfx.tap();
                    handle.close();
                  },
                },
                icon(ICONS.close),
              ),
          ),
        );
      }
      panel.append(h('div.sheet-body', null, body));
      if (dismissable) backdrop.addEventListener('click', () => handle.close());
      // While a sheet is open the screen behind it cannot be reached by keyboard or screen reader.
      const before = document.activeElement;
      sheetHost.append(wrap);
      sheets.push(handle);
      screenHost.inert = true;
      panel.tabIndex = -1;
      const first = panel.querySelector('button, input, a[href]');
      (first instanceof HTMLElement ? first : panel).focus({ preventScroll: true });
      handle.restoreFocus = () => {
        if (sheets.length === 0) screenHost.inert = false;
        if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
      };
      handle.dismissable = dismissable;
      return handle;
    },

    /** True while a sheet is open (the game ignores swipes then). */
    sheetOpen: () => sheets.length > 0,

    /**
     * Android's Back button. Closes the top sheet if it may be dismissed.
     * @returns {boolean} true if a sheet was open (closed or not), so Back goes no further
     */
    back() {
      if (!sheets.length) return false;
      const top = sheets[sheets.length - 1];
      if (top.dismissable) top.close();
      return true;
    },
  };
}

/**
 * A button that makes the tap sound and unlocks audio.
 * @param {string} tag
 * @param {Record<string, any>} props  `onclick` is wrapped
 */
export function button(tag, props, ...children) {
  const { onclick, ...rest } = props || {};
  return h(
    tag,
    {
      type: 'button',
      ...rest,
      onclick: (e) => {
        unlockAudio();
        sfx.tap();
        if (onclick) onclick(e);
      },
    },
    ...children,
  );
}
