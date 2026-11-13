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

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const int = (v, lo, hi, fallback) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);

/** A saved attempt, or null if it is not shaped like one. */
function cleanResume(r) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.taps)) return null;
  if (typeof r.id !== 'number' && typeof r.id !== 'string') return null;
  return {
    id: r.id,
    taps: r.taps.filter((b) => Number.isInteger(b) && b >= 0 && b < 30),
    hints: int(r.hints, 0, 999, 0),
    extra: int(r.extra, 0, 1, 0),
    hinted: Number.isInteger(r.hinted) ? r.hinted : -1,
  };
}

/**
 * Make sure every value has the type the game expects, so that a damaged save
 * (or one from a future version) can never stop the game from starting.
 */
export function sanitize(state) {
  state.level = int(state.level, 1, 1e7, 1);
  state.hints = int(state.hints, 0, 99999, 3);
  for (const k of Object.keys(state.stats)) state.stats[k] = int(state.stats[k], 0, 1e9, 0);
  for (const k of Object.keys(state.stars)) {
    const v = int(state.stars[k], 1, 3, 0);
    if (v && /^\d+$/.test(k)) state.stars[k] = v;
    else delete state.stars[k];
  }
  for (const k of Object.keys(state.seen)) state.seen[k] = state.seen[k] === true;
  const d = state.daily;
  d.streak = int(d.streak, 0, 1e6, 0);
  d.best = int(d.best, 0, 1e6, 0);
  if (typeof d.lastSolved !== 'string' || !DATE.test(d.lastSolved)) {
    d.lastSolved = null;
    d.streak = 0;
  }
  if (typeof d.repairOffered !== 'string' || !DATE.test(d.repairOffered)) d.repairOffered = null;
  for (const key of Object.keys(d.history)) {
    const e = d.history[key];
    if (!DATE.test(key) || !e || typeof e !== 'object') {
      delete d.history[key];
      continue;
    }
    d.history[key] = {
      won: e.won === true,
      slips: int(e.slips, 0, 99, 0),
      stars: int(e.stars, 0, 3, 0),
      hints: int(e.hints, 0, 999, 0),
      extra: int(e.extra, 0, 1, 0),
      story: typeof e.story === 'string' ? e.story.replace(/[^01]/g, '').slice(0, 99) : '',
      taps: typeof e.taps === 'string' ? e.taps.replace(/[^0-9a-t]/g, '').slice(0, 99) : '',
    };
  }
  state.resume.campaign = cleanResume(state.resume.campaign);
  state.resume.daily = cleanResume(state.resume.daily);
  state.ads.levelsSince = int(state.ads.levelsSince, 0, 1e6, 0);
  return state;
}

export function createStore(persist) {
  let timer = null;
  /** Something has changed since the last write. */
  let dirty = false;
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
      store.state = sanitize(mergeState(defaultState(), saved));
      dirty = false;
      return store.state;
    },

    /** Write soon. Calls made close together are folded into one write. */
    save() {
      dirty = true;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        store.flush();
      }, 150);
    },

    /**
     * Write now (used when the app is about to be hidden). Does nothing if
     * nothing changed, so a copy of the game left open in another browser tab
     * cannot overwrite newer progress just by being closed.
     */
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!dirty) return Promise.resolve();
      dirty = false;
      try {
        return Promise.resolve(persist.set(KEY, JSON.stringify(store.state)));
      } catch {
        return Promise.resolve();
      }
    },

    /** Forget everything and start again (offered if a save cannot be used at all). */
    async reset() {
      store.state = defaultState();
      dirty = true;
      await store.flush();
    },
  };
  return store;
}

/** The storage key of the save, for anything that needs to watch it. */
export const SAVE_KEY = KEY;
