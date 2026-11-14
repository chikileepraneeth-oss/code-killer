// All sounds are synthesised with the Web Audio API - no asset files needed.

let ctx = null;
let master = null;
let noiseBuf = null;
let ambient = null;

export function initAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.7;
  master.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

const ready = () => ctx && ctx.state === 'running';

function env(g, t, a, peak, rel) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + rel);
}

function tone(freq, { type = 'sine', dur = 0.2, vol = 0.3, slide = null, delay = 0, out = master } = {}) {
  if (!ready()) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
  env(g, t, 0.005, vol, dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise({ dur = 0.15, vol = 0.3, freq = 800, q = 1, type = 'bandpass', delay = 0, out = master } = {}) {
  if (!ready()) return;
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  env(g, t, 0.004, vol, dur);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random() * 0.3);
  src.stop(t + dur + 0.05);
}

export function setListener(pos, forward) {
  if (!ready()) return;
  const l = ctx.listener;
  if (l.positionX) {
    l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
    l.forwardX.value = forward.x; l.forwardY.value = forward.y; l.forwardZ.value = forward.z;
    l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
  } else {
    l.setPosition(pos.x, pos.y, pos.z);
    l.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
  }
}

/** Positional footstep at world position (x, z). */
export function footstep(x, z, vol = 0.5) {
  if (!ready()) return;
  const p = ctx.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'inverse';
  p.refDistance = 2;
  p.maxDistance = 40;
  p.rolloffFactor = 1.4;
  if (p.positionX) { p.positionX.value = x; p.positionY.value = 0.1; p.positionZ.value = z; }
  else p.setPosition(x, 0.1, z);
  p.connect(master);
  noise({ dur: 0.07, vol: vol * 0.8, freq: 300 + Math.random() * 200, q: 0.8, type: 'lowpass', out: p });
  tone(70 + Math.random() * 20, { dur: 0.06, vol: vol * 0.5, out: p });
  setTimeout(() => p.disconnect(), 400);
}

/** Positional one-shot helper. */
function at(x, y, z, fn, ref = 2) {
  if (!ready()) return;
  const p = ctx.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'inverse';
  p.refDistance = ref;
  p.maxDistance = 40;
  p.rolloffFactor = 1.4;
  if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; } else p.setPosition(x, y, z);
  p.connect(master);
  fn(p);
  setTimeout(() => p.disconnect(), 1500);
}

/** Metallic clank from someone crawling in a vent. */
export function clank(x, y, z) {
  at(x, y, z, (out) => {
    tone(320 + Math.random() * 200, { type: 'square', dur: 0.08, vol: 0.15, out });
    tone(1200 + Math.random() * 600, { type: 'triangle', dur: 0.15, vol: 0.08, out });
    noise({ dur: 0.05, vol: 0.2, freq: 2500, q: 3, out });
  }, 1.5);
}

export function doorSound(x, y, z, open) {
  at(x, y, z, (out) => {
    noise({ dur: 0.25, vol: 0.25, freq: open ? 600 : 300, q: 1.5, out });
    tone(open ? 140 : 90, { type: 'sawtooth', dur: 0.2, vol: 0.06, slide: open ? 200 : 60, out });
  });
}

export function puffSound(x, y, z) {
  at(x, y, z, (out) => noise({ dur: 1.2, vol: 0.35, freq: 900, q: 0.5, out }), 3);
}

let siren = null;
export function sirenFor(ms) {
  if (!ready() || siren) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  const lfo = ctx.createOscillator();
  const lg = ctx.createGain();
  o.type = 'sawtooth';
  o.frequency.value = 600;
  lfo.frequency.value = 1.6;
  lg.gain.value = 260;
  lfo.connect(lg).connect(o.frequency);
  g.gain.value = 0.0001;
  g.gain.exponentialRampToValueAtTime(0.07, ctx.currentTime + 0.1);
  g.gain.setValueAtTime(0.07, ctx.currentTime + ms / 1000 - 0.2);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
  o.connect(g).connect(master);
  o.start();
  lfo.start();
  o.stop(ctx.currentTime + ms / 1000 + 0.05);
  lfo.stop(ctx.currentTime + ms / 1000 + 0.05);
  siren = o;
  setTimeout(() => { siren = null; }, ms + 100);
}

let rainNode = null;
export function setRain(on) {
  if (!ready()) return;
  if (on && !rainNode) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2500;
    f.Q.value = 0.4;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    src.connect(f).connect(g).connect(master);
    src.start();
    rainNode = { src, g };
  } else if (!on && rainNode) {
    rainNode.src.stop();
    rainNode = null;
  }
}

export function ownStep() {
  noise({ dur: 0.05, vol: 0.08, freq: 350, type: 'lowpass' });
}

export const sfx = {
  click: () => tone(900, { type: 'square', dur: 0.03, vol: 0.05 }),
  key: () => tone(1200 + Math.random() * 200, { type: 'square', dur: 0.025, vol: 0.06 }),
  open: () => { tone(220, { type: 'sawtooth', dur: 0.15, vol: 0.08, slide: 440 }); },
  close: () => tone(440, { type: 'sawtooth', dur: 0.12, vol: 0.06, slide: 200 }),
  wrong: () => { tone(160, { type: 'sawtooth', dur: 0.35, vol: 0.2 }); tone(150, { type: 'square', dur: 0.35, vol: 0.12 }); },
  kill: () => {
    noise({ dur: 0.5, vol: 0.5, freq: 1800, q: 0.5 });
    tone(880, { type: 'sawtooth', dur: 0.6, vol: 0.18, slide: 55 });
    tone(55, { dur: 0.8, vol: 0.5, slide: 30 });
  },
  death: () => { tone(300, { type: 'sawtooth', dur: 1.4, vol: 0.25, slide: 40 }); noise({ dur: 1.2, vol: 0.3, freq: 400, type: 'lowpass' }); },
  distantDeath: () => { tone(120, { dur: 0.6, vol: 0.18, slide: 50 }); },
  pickup: () => { [660, 880, 1320].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.18, vol: 0.12, delay: i * 0.06 })); },
  codeChanged: () => { for (let i = 0; i < 8; i++) tone(400 + Math.random() * 1600, { type: 'square', dur: 0.05, vol: 0.05, delay: i * 0.04 }); },
  hood: () => { tone(330, { type: 'triangle', dur: 0.4, vol: 0.15, slide: 660 }); },
  beep: (hi = false) => tone(hi ? 1320 : 660, { type: 'square', dur: 0.09, vol: 0.08 }),
  lightsOut: () => { tone(110, { type: 'sawtooth', dur: 1.5, vol: 0.2, slide: 40 }); noise({ dur: 0.3, vol: 0.4, freq: 3000, q: 2 }); },
  zone: () => { tone(200, { type: 'sine', dur: 0.8, vol: 0.18, slide: 120 }); tone(203, { type: 'sine', dur: 0.8, vol: 0.18, slide: 122 }); },
  hurt: () => noise({ dur: 0.08, vol: 0.12, freq: 200, type: 'lowpass' }),
  item: () => { [880, 1175].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.12, vol: 0.12, delay: i * 0.07 })); },
  use: () => tone(520, { type: 'square', dur: 0.12, vol: 0.08, slide: 1040 }),
  glimpse: () => { tone(2093, { type: 'sine', dur: 0.9, vol: 0.08 }); tone(2637, { type: 'sine', dur: 0.9, vol: 0.05, delay: 0.1 }); },
  bounty: () => { [392, 523, 659].forEach((f, i) => tone(f, { type: 'square', dur: 0.15, vol: 0.08, delay: i * 0.1 })); },
  click2: () => tone(1500, { type: 'square', dur: 0.02, vol: 0.06 }),
  locked: () => { tone(200, { type: 'square', dur: 0.08, vol: 0.1 }); tone(160, { type: 'square', dur: 0.08, vol: 0.1, delay: 0.1 }); },
  win: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.4, vol: 0.15, delay: i * 0.12 })); },
};

/** Low sinister drone while in game. */
export function setAmbient(on) {
  if (!ready()) return;
  if (on && !ambient) {
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 2);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 400;
    const oscs = [55, 55.4, 82.4].map((fr) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = fr;
      o.connect(f);
      o.start();
      return o;
    });
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.frequency.value = 0.08;
    lg.gain.value = 180;
    lfo.connect(lg).connect(f.frequency);
    lfo.start();
    f.connect(g).connect(master);
    ambient = { g, oscs: [...oscs, lfo] };
  } else if (!on && ambient) {
    const a = ambient;
    ambient = null;
    a.g.gain.linearRampToValueAtTime(0, ctx.currentTime + 1);
    setTimeout(() => a.oscs.forEach((o) => o.stop()), 1200);
  }
}
