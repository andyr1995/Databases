// The player's saved progress: one JSON document, kept in memory and written
// through platform.persist (localStorage on the web, native preferences in the app).

const KEY = 'save.v1';

export function defaultState() {
  return {
    v: 1,
    /** Next campaign level to play, 1-based. */
    level: 1,
    hints: 3,
    removeAds: false,
    /** Remove Ads came with bonus hints; remember that they were handed over. */
    purchaseBonus: false,
    settings: { sound: true, haptics: true },
    stats: { solved: 0, perfect: 0, hintsUsed: 0, dailies: 0 },
    /** Best star count per campaign level number. */
    stars: {},
    /** Which explanations the player has already been shown. */
    seen: {},
    daily: {
      streak: 0,
      best: 0,
      lastSolved: null,
      /** The date a streak repair was last offered, so it is offered once. */
      repairOffered: null,
      /** dateKey -> {won, slips, stars, hints, extra, story, taps} */
      history: {},
    },
    /** In-progress boards so a level survives the app being closed: {id, taps, hints, extra}. */
    resume: { campaign: null, daily: null },
    ads: { levelsSince: 0 },
  };
}

/** Dictionaries whose keys are data (level numbers, dates), not a fixed shape. */
const OPEN_DICTS = new Set(['stars', 'seen', 'history']);

/** Fill in anything missing from an older or damaged save without losing what is there. */
export function mergeState(base, saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return base;
  const out = { ...base };
  for (const k of Object.keys(base)) {
    const b = base[k];
    const s = saved[k];
    if (s === undefined || s === null) continue;
    if (b !== null && typeof b === 'object' && !Array.isArray(b)) {
      // Dictionaries with open-ended keys are taken whole; fixed-shape objects are merged.
      const open = OPEN_DICTS.has(k);
      out[k] = typeof s === 'object' && !Array.isArray(s) ? (open ? { ...s } : mergeState(b, s)) : b;
    } else if (b === null || typeof s === typeof b) {
      out[k] = s;
    }
  }
  return out;
}

export function createStore(persist) {
  let timer = null;
  const store = {
    state: defaultState(),

    async load() {
      let saved = null;
      try {
        const raw = await persist.get(KEY);
        if (raw) saved = JSON.parse(raw);
      } catch {
        saved = null;
      }
      store.state = mergeState(defaultState(), saved);
      return store.state;
    },

    /** Write soon. Calls made close together are folded into one write. */
    save() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        store.flush();
      }, 150);
    },

    /** Write now (used when the app is about to be hidden). */
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        return persist.set(KEY, JSON.stringify(store.state));
      } catch {
        return Promise.resolve();
      }
    },
  };
  return store;
}
