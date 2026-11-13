// A tiny WebAudio synthesiser. Every sound in the game is generated here, so
// there are no audio files to license, load or cache.

let ctx = null;
let master = null;
let enabled = true;
let ducked = false;

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    return null;
  }
  master = ctx.createGain();
  master.gain.value = 0.55;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -14;
  limiter.ratio.value = 6;
  master.connect(limiter);
  limiter.connect(ctx.destination);
  return ctx;
}

/** Browsers only start audio from a user gesture; call this from the first tap. */
export function unlockAudio() {
  const c = ensure();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

export function setSoundEnabled(on) {
  enabled = !!on;
}

/** Silence everything while an advert is on screen or the app is in the background. */
export function setDucked(on) {
  ducked = !!on;
  if (!ctx) return;
  if (on) ctx.suspend().catch(() => {});
  else ctx.resume().catch(() => {});
}

const ready = () => enabled && !ducked && ensure() && ctx.state === 'running';

/**
 * One enveloped oscillator note.
 * @param {{freq: number, to?: number, dur?: number, type?: OscillatorType, vol?: number, at?: number, attack?: number}} o
 */
export function tone({ freq, to, dur = 0.12, type = 'sine', vol = 0.25, at = 0, attack = 0.004 }) {
  if (!ready()) return;
  const t0 = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain);
  gain.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/**
 * A burst of filtered noise (thuds, swishes, clicks).
 * @param {{dur?: number, vol?: number, at?: number, freq?: number, to?: number, q?: number, kind?: BiquadFilterType}} o
 */
export function noise({ dur = 0.08, vol = 0.2, at = 0, freq = 1200, to, q = 0.8, kind = 'bandpass' }) {
  if (!ready()) return;
  const t0 = ctx.currentTime + at;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = kind;
  filter.frequency.setValueAtTime(freq, t0);
  if (to) filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/** Equal-tempered frequency for a MIDI note number. */
export const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
