/* ============================================================================
   Dengue Defense — Field Edition :: Audio & Haptics (WebAudio Synth)
   100% synthesized, zero external assets. Safe to import in bare Node:
   no AudioContext / window / document / localStorage / navigator access at
   module scope. Everything browser-side is lazy-initialized inside functions.
   ============================================================================ */

/* Pentatonic ladder used to escalate swat pitch as combo rises. */
const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5]; // C5 D5 E5 G5 A5 C6
const PENTATONIC_MIN = 0;
const PENTATONIC_MAX = PENTATONIC.length - 1;

const AUDIO_KEY = 'dd_audio';
const HAPTICS_KEY = 'dd_haptics';

const rnd = (a, b) => a + Math.random() * (b - a);
const clampTier = (tier) => {
  const n = Math.floor(Number(tier));
  if (!Number.isFinite(n)) return 0;
  return Math.max(PENTATONIC_MIN, Math.min(PENTATONIC_MAX, n));
};

function safeStorageGet(key, fallback) {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const v = localStorage.getItem(key);
    return v === null || v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function safeStorageSet(key, value) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

function safeVibrate(pattern) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      return navigator.vibrate(pattern);
    }
  } catch (e) { /* haptics are best-effort */ }
  return false;
}

function readFeverFlag() {
  /* Legacy compat: honor a global W.feverActive if the host still exposes it. */
  try {
    if (typeof globalThis !== 'undefined' && globalThis.W && typeof globalThis.W.feverActive !== 'undefined') {
      return !!globalThis.W.feverActive;
    }
  } catch (e) { /* ignore */ }
  return !!SFX.feverActive;
}

/* ---------------- SFX SYNTH ---------------- */
export const SFX = {
  ctx: null,
  master: null,
  on: true,
  haptics: true,
  comboTier: 0,
  feverActive: false,
  buzzNodes: null,
  ambientNodes: null,
  musicActive: false,
  musicStep: 0,
  musicTimer: null,
  _prefsLoaded: false,

  /* Lazy-load persisted prefs (dd_audio / dd_haptics), default on. */
  _loadPrefs() {
    if (this._prefsLoaded) return;
    this._prefsLoaded = true;
    this.on = safeStorageGet(AUDIO_KEY, '1') !== '0';
    this.haptics = safeStorageGet(HAPTICS_KEY, '1') !== '0';
  },

  init() {
    this._loadPrefs();
    if (!this.ctx) {
      try {
        if (typeof window !== 'undefined') {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) this.ctx = new AC();
        }
      } catch (e) { this.ctx = null; }
      if (this.ctx) {
        try {
          this.master = this.ctx.createGain();
          this.master.gain.setValueAtTime(this.on ? 1 : 0, this.ctx.currentTime);
          this.master.connect(this.ctx.destination);
        } catch (e) { this.master = null; }
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      try { this.ctx.resume(); } catch (e) { /* noop */ }
    }
    return !!this.ctx;
  },

  /* Output node: master gain when available, else raw destination. */
  _out() {
    return this.master || (this.ctx && this.ctx.destination) || null;
  },

  setComboPitch(comboTier) {
    this.comboTier = clampTier(comboTier);
    return PENTATONIC[this.comboTier];
  },

  tone(f, d, type = 'sine', v = 0.06, f2 = null, delay = 0) {
    if (!this.on || !this.ctx) return;
    const out = this._out(); if (!out) return;
    const c = this.ctx, t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t + d);
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + d + 0.02);
  },

  noise(d, v = 0.08, freq = 1200, delay = 0) {
    if (!this.on || !this.ctx) return;
    const out = this._out(); if (!out) return;
    const c = this.ctx, t = c.currentTime + delay, len = Math.max(1, Math.floor(c.sampleRate * d));
    const buf = c.createBuffer(1, len, c.sampleRate), data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = buf; f.type = 'lowpass'; f.frequency.value = freq; g.gain.value = v;
    s.connect(f); f.connect(g); g.connect(out); s.start(t);
  },

  play(name) {
    if (!this.on) return;
    this.init();
    if (!this.ctx) return;
    switch (name) {
      case 'tap': this.tone(720, 0.05, 'triangle', 0.05, 1100); break;
      case 'deploy': this.tone(520, 0.08, 'triangle', 0.06, 880); this.tone(1040, 0.1, 'sine', 0.04, 1320, 0.06); break;
      case 'undeploy': this.tone(700, 0.08, 'triangle', 0.05, 380); break;
      case 'deny': this.tone(180, 0.15, 'sawtooth', 0.07, 110); break;
      case 'swat': {
        const baseF = this.comboTier > 0 ? PENTATONIC[this.comboTier] : rnd(280, 360);
        this.noise(0.08, 0.22, 2600);
        this.tone(baseF, 0.07, 'square', 0.05, baseF * 0.35);
        break;
      }
      case 'slice': {
        this.noise(0.04, 0.08, 3400);
        this.tone(920, 0.04, 'triangle', 0.03, 460);
        break;
      }
      case 'zap': {
        this.noise(0.09, 0.18, 4200);
        this.tone(1200, 0.08, 'sawtooth', 0.04, 220);
        break;
      }
      case 'hit': this.noise(0.05, 0.1, 1500); break;
      case 'miss': this.tone(240, 0.04, 'sine', 0.02, 170); break;
      case 'bite': this.tone(140, 0.22, 'sawtooth', 0.07, 65); break;
      case 'coin': this.tone(988, 0.08, 'square', 0.04); this.tone(1319, 0.18, 'square', 0.04, null, 0.07); break;
      case 'fog': this.noise(0.5, 0.07, 600); break;
      case 'spray': this.noise(0.7, 0.24, 1900); this.tone(480, 0.35, 'sine', 0.04, 150); break;
      case 'trap': this.tone(1300, 0.06, 'square', 0.03, 400); break;
      case 'drain': {
        this.tone(350, 0.12, 'sine', 0.06, 750);
        this.noise(0.12, 0.14, 1600, 0.04);
        break;
      }
      case 'heal': [440, 554, 659, 880].forEach((f, i) => this.tone(f, 0.14, 'sine', 0.04, null, i * 0.05)); break;
      case 'wolbachia': [587, 880, 1174].forEach((f, i) => this.tone(f, 0.12, 'triangle', 0.04, null, i * 0.05)); break;
      case 'combo': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.12, 'triangle', 0.05, null, i * 0.05)); break;
      case 'fever': [523, 659, 784, 1047, 1318, 1568].forEach((f, i) => this.tone(f, 0.16, 'sawtooth', 0.04, f * 1.05, i * 0.04)); break;
      case 'wave': this.tone(220, 0.5, 'sawtooth', 0.05, 440); this.tone(330, 0.5, 'sawtooth', 0.03, 660, 0.1); break;
      case 'queen': this.tone(110, 0.7, 'sawtooth', 0.09, 50); this.noise(0.4, 0.12, 400); break;
      case 'thunder': {
        this.noise(0.85, 0.28, 320);
        this.tone(85, 0.75, 'triangle', 0.08, 38);
        break;
      }
      case 'achieve': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.2, 'square', 0.04, null, i * 0.07)); break;
      case 'win': [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.25, 'triangle', 0.06, null, i * 0.1)); break;
      case 'lose': [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.35, 'sawtooth', 0.05, null, i * 0.16)); break;
      case 'star': this.tone(1200, 0.15, 'sine', 0.05, 1800); break;
      /* Names referenced by legacy call sites that had no synth voice; give them one. */
      case 'end': this.tone(392, 0.3, 'triangle', 0.06, 523); this.tone(523, 0.42, 'triangle', 0.05, 659, 0.12); break;
      case 'report': this.tone(880, 0.09, 'triangle', 0.05, 1174); this.noise(0.05, 0.06, 2200, 0.03); break;
      case 'lit': this.tone(1568, 0.12, 'sine', 0.05, 2093); break;
      default: break;
    }
  },

  startBuzz() {
    if (!this.on || !this.ctx || this.buzzNodes) return;
    const out = this._out(); if (!out) return;
    const c = this.ctx, o1 = c.createOscillator(), o2 = c.createOscillator(), lfo = c.createOscillator(), lg = c.createGain(), f = c.createBiquadFilter(), g = c.createGain();
    o1.type = 'sawtooth'; o2.type = 'sawtooth'; o1.frequency.value = 410; o2.frequency.value = 417;
    lfo.frequency.value = 7; lg.gain.value = 18; lfo.connect(lg); lg.connect(o1.frequency); lg.connect(o2.frequency);
    f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 2; g.gain.value = 0;
    o1.connect(f); o2.connect(f); f.connect(g); g.connect(out);
    o1.start(); o2.start(); lfo.start();
    this.buzzNodes = { o1, o2, lfo, g };
  },

  setBuzz(n) {
    if (this.buzzNodes && this.ctx) {
      this.buzzNodes.g.gain.setTargetAtTime(this.on ? Math.min(0.038, n * 0.0025) : 0, this.ctx.currentTime, 0.1);
    }
  },

  stopBuzz() {
    if (!this.buzzNodes) return;
    const b = this.buzzNodes;
    if (this.ctx) b.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    const timer = (typeof setTimeout !== 'undefined') ? setTimeout : null;
    if (timer) {
      timer(() => { try { b.o1.stop(); b.o2.stop(); b.lfo.stop(); } catch (e) { /* already stopped */ } }, 300);
    } else {
      try { b.o1.stop(); b.o2.stop(); b.lfo.stop(); } catch (e) { /* already stopped */ }
    }
    this.buzzNodes = null;
  },

  startMusic() {
    if (!this.on || !this.ctx || this.musicActive) return;
    this.musicActive = true;
    this.musicStep = 0;
    this.musicTick();
  },

  stopMusic() {
    this.musicActive = false;
    if (typeof clearTimeout !== 'undefined') clearTimeout(this.musicTimer);
    this.musicTimer = null;
  },

  musicTick() {
    if (!this.musicActive || !this.on || !this.ctx || this.ctx.state === 'suspended') return;
    const isFever = readFeverFlag();
    const bpm = isFever ? 140 : 116;
    const stepMs = (60 / bpm / 4) * 1000;
    const s = this.musicStep % 16;
    if (s % 4 === 0) {
      this.tone(110, 0.06, 'sine', isFever ? 0.07 : 0.045, 30);
    }
    /* Combo tier 4+ (x4 / x5): subtle layered bass pulse on every quarter note. */
    if (this.comboTier >= 4 && s % 2 === 0) {
      this.tone(55, 0.22, 'sine', isFever ? 0.075 : 0.055, 41);
    }
    if (s % 2 === 1) {
      this.noise(0.02, 0.012, 5500);
    }
    if (s % 2 === 0) {
      const bassNotes = [73.42, 73.42, 87.31, 73.42, 98.00, 73.42, 110.00, 98.00];
      const freq = bassNotes[(s / 2) % bassNotes.length];
      this.tone(freq, 0.09, 'sawtooth', isFever ? 0.03 : 0.018, freq * 0.9);
    }
    this.musicStep++;
    if (typeof setTimeout !== 'undefined') {
      this.musicTimer = setTimeout(() => this.musicTick(), stepMs);
    }
  },
};

/* ---------------- PUBLIC TOGGLE API (persisted) ---------------- */

export function setAudioEnabled(enabled) {
  SFX._loadPrefs();
  SFX.on = !!enabled;
  safeStorageSet(AUDIO_KEY, SFX.on ? '1' : '0');
  if (SFX.ctx && SFX.master) {
    try { SFX.master.gain.setTargetAtTime(SFX.on ? 1 : 0, SFX.ctx.currentTime, 0.05); } catch (e) { /* noop */ }
    if (SFX.ctx.state === 'suspended' && SFX.on) { try { SFX.ctx.resume(); } catch (e) { /* noop */ } }
  }
  if (!SFX.on) {
    SFX.setBuzz(0);
    SFX.stopMusic();
  }
  return SFX.on;
}

export function isAudioEnabled() {
  SFX._loadPrefs();
  return !!SFX.on;
}

export function setHapticsEnabled(enabled) {
  SFX._loadPrefs();
  SFX.haptics = !!enabled;
  safeStorageSet(HAPTICS_KEY, SFX.haptics ? '1' : '0');
  if (SFX.haptics) safeVibrate(30);
  return SFX.haptics;
}

export function isHapticsEnabled() {
  SFX._loadPrefs();
  return !!SFX.haptics;
}

/* Haptics wrapper: navigator.vibrate guarded for bare Node / desktop. */
export function vibrate(pattern = 30) {
  SFX._loadPrefs();
  if (!SFX.haptics) return false;
  return safeVibrate(pattern);
}

export const PENTATONIC_SCALE = PENTATONIC.slice();
