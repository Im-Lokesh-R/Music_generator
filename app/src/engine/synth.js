// Audio renderer: turns note tracks into a mixed stereo AudioBuffer using the
// Web Audio API (OfflineAudioContext → renders faster than real time).
// Every instrument is synthesised (no sample files needed):
//   piano  – additive harmonics + pitch-dependent decay + hammer brightness envelope
//   guitar – Karplus–Strong plucked string (physical model)
//   bass   – saw + sub-sine through an enveloped low-pass
//   drums  – synthesised kit (sine-sweep kick, noise snare/hats/cymbals, toms…)
//   violin – bowed saw with formant filters and delayed vibrato
//   strings– detuned saw ensemble with slow attack
//   flute  – sine/triangle + breath noise + vibrato
//   synth  – lead / arp / pad patches
// Then: per-track tone filter, pan, reverb & delay sends, master lo-fi chain,
// risers/impacts at drops, compressor, normalisation.

import { DRUM } from './instruments.js';
import { clamp, makeRng } from './theory.js';

const SR = 32000;
const mtof = (p) => 440 * Math.pow(2, (p - 69) / 12);

function noiseBuffer(ctx, seconds = 2, seed = 1) {
  const rng = makeRng(seed);
  const b = ctx.createBuffer(1, Math.floor(SR * seconds), SR);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = rng.next() * 2 - 1;
  return b;
}

function impulseResponse(ctx, seconds, decay, seed = 7) {
  const rng = makeRng(seed);
  const len = Math.floor(SR * seconds);
  const b = ctx.createBuffer(2, len, SR);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    const pre = Math.floor(SR * 0.012);
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / len;
      lp = lp * 0.55 + (rng.next() * 2 - 1) * 0.45; // darken the tail a little
      d[i] = lp * Math.pow(1 - t, decay) * (i < pre + 2000 ? 0.6 + 0.4 * rng.next() : 1);
    }
  }
  return b;
}

// ---------------------------------------------------------------- envelopes
function adsr(param, t0, dur, { a = 0.01, d = 0.1, s = 0.7, r = 0.2, peak = 1 }) {
  const end = t0 + Math.max(dur, a + 0.01);
  param.setValueAtTime(0.0001, t0);
  param.linearRampToValueAtTime(peak, t0 + a);
  param.setTargetAtTime(peak * s, t0 + a, d / 3);
  param.setTargetAtTime(0.0001, end, r / 4);
  return end + r * 1.5;
}

// ---------------------------------------------------------------- instruments
class Voices {
  constructor(ctx, out, opts) {
    this.ctx = ctx;
    this.out = out;
    this.opts = opts;
    this.noise = opts.noise;
    this.ksCache = new Map();
    const harmonics = [0, 1, 0.55, 0.32, 0.22, 0.12, 0.09, 0.05, 0.035, 0.02, 0.012];
    this.pianoWave = ctx.createPeriodicWave(new Float32Array(harmonics.length), new Float32Array(harmonics));
    const flute = [0, 1, 0.18, 0.06, 0.02];
    this.fluteWave = ctx.createPeriodicWave(new Float32Array(flute.length), new Float32Array(flute));
  }

  piano(p, t, dur, v) {
    const { ctx } = this;
    const f = mtof(p);
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.4;
    lp.frequency.setValueAtTime(Math.min(16000, f * (3 + 10 * v)), t);
    lp.frequency.setTargetAtTime(Math.min(12000, f * 2.2), t + 0.01, 0.4);
    const tau = clamp(1.5 * Math.pow(2, -(p - 60) / 20), 0.25, 4);
    const peak = 0.32 * v;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.004);
    g.gain.setTargetAtTime(peak * 0.0001, t + 0.004, tau);
    const end = t + Math.min(dur, tau * 5);
    g.gain.cancelScheduledValues(end);
    g.gain.setTargetAtTime(0.0001, end, 0.09);
    const stop = end + 0.6;
    for (const det of [-3, 3]) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(this.pianoWave);
      o.frequency.value = f;
      o.detune.value = det;
      o.connect(lp);
      o.start(t);
      o.stop(stop);
    }
    // hammer thump
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = Math.min(8000, f * 4);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.05 * v, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    n.connect(nf).connect(ng).connect(this.out);
    n.start(t, Math.random() * 0.5, 0.05);
    lp.connect(g).connect(this.out);
  }

  ksBuffer(p, brightness) {
    const key = `${p}`;
    if (this.ksCache.has(key)) return this.ksCache.get(key);
    const f = mtof(p);
    const N = Math.max(2, Math.round(SR / f));
    const len = Math.floor(SR * 3);
    const b = this.ctx.createBuffer(1, len, SR);
    const d = b.getChannelData(0);
    const rng = makeRng(p * 13 + 1);
    // excitation: low-passed noise burst (brightness = pick hardness)
    let lp = 0;
    const alpha = 0.25 + 0.65 * brightness;
    for (let i = 0; i < N; i++) {
      lp = lp + alpha * (rng.next() * 2 - 1 - lp);
      d[i] = lp;
    }
    const decay = 0.9965 - Math.max(0, p - 60) * 0.00012;
    for (let i = N; i < len; i++) d[i] = decay * 0.5 * (d[i - N] + d[i - N - 1 >= 0 ? i - N - 1 : i - N]);
    let max = 0;
    for (let i = 0; i < N * 4; i++) max = Math.max(max, Math.abs(d[i]));
    const s = max > 0 ? 1 / max : 1;
    for (let i = 0; i < len; i++) d[i] *= s;
    const entry = { buffer: b, rate: SR / f / N };
    this.ksCache.set(key, entry);
    return entry;
  }

  guitar(p, t, dur, v) {
    const { ctx } = this;
    const { buffer, rate } = this.ksBuffer(p, 0.55);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 1 / rate;
    const g = ctx.createGain();
    const end = t + Math.min(dur + 0.05, 2.8);
    g.gain.setValueAtTime(0.28 * v, t);
    g.gain.setTargetAtTime(0.0001, end, 0.06);
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 220;
    body.gain.value = 4;
    src.connect(body).connect(g).connect(this.out);
    src.start(t);
    src.stop(end + 0.4);
  }

  bass(p, t, dur, v) {
    const { ctx } = this;
    const f = mtof(p);
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(f * (5 + 6 * v), t);
    lp.frequency.setTargetAtTime(f * 2.2, t, 0.08);
    const stop = adsr(g.gain, t, dur * 0.95, { a: 0.006, d: 0.25, s: 0.65, r: 0.08, peak: 0.42 * v });
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = f;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = f;
    const subG = ctx.createGain();
    subG.gain.value = 0.9;
    saw.connect(lp);
    sub.connect(subG).connect(lp);
    lp.connect(g).connect(this.out);
    for (const o of [saw, sub]) {
      o.start(t);
      o.stop(stop);
    }
  }

  bowed(p, t, dur, v, { ensemble = false } = {}) {
    const { ctx } = this;
    const f = mtof(p);
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = ensemble ? 1800 + 2500 * v : 2600 + 4000 * v;
    const f1 = ctx.createBiquadFilter();
    f1.type = 'peaking';
    f1.frequency.value = 450;
    f1.Q.value = 1.2;
    f1.gain.value = 5;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'peaking';
    f2.frequency.value = 2800;
    f2.Q.value = 1.5;
    f2.gain.value = ensemble ? 2 : 6;
    const a = ensemble ? Math.min(0.45, dur * 0.4) : Math.min(0.12, dur * 0.3);
    const stop = adsr(g.gain, t, dur, { a, d: 0.3, s: 0.85, r: ensemble ? 0.5 : 0.18, peak: (ensemble ? 0.07 : 0.16) * v });
    // vibrato fades in after the note starts
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.2 + Math.random() * 0.6;
    const lfoG = ctx.createGain();
    lfoG.gain.setValueAtTime(0, t);
    lfoG.gain.linearRampToValueAtTime(f * (ensemble ? 0.003 : 0.006), t + Math.min(0.5, dur * 0.6) + 0.05);
    lfo.connect(lfoG);
    const detunes = ensemble ? [-9, -2, 6] : [-3, 3];
    for (const det of detunes) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det;
      lfoG.connect(o.frequency);
      o.connect(f1);
      o.start(t);
      o.stop(stop);
    }
    f1.connect(f2).connect(lp).connect(g).connect(this.out);
    lfo.start(t);
    lfo.stop(stop);
  }

  flute(p, t, dur, v) {
    const { ctx } = this;
    const f = mtof(p);
    const g = ctx.createGain();
    const stop = adsr(g.gain, t, dur, { a: 0.06, d: 0.2, s: 0.8, r: 0.12, peak: 0.2 * v });
    const o = ctx.createOscillator();
    o.setPeriodicWave(this.fluteWave);
    o.frequency.value = f;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 4.8;
    const lfoG = ctx.createGain();
    lfoG.gain.setValueAtTime(0, t);
    lfoG.gain.linearRampToValueAtTime(f * 0.005, t + 0.4);
    lfo.connect(lfoG).connect(o.frequency);
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f * 2;
    bp.Q.value = 2;
    const ng = ctx.createGain();
    ng.gain.value = 0.22;
    n.connect(bp).connect(ng).connect(g);
    o.connect(g).connect(this.out);
    for (const s of [o, lfo, n]) {
      s.start(t);
      s.stop(stop);
    }
  }

  synth(p, t, dur, v, role) {
    const { ctx } = this;
    const f = mtof(p);
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    let stop;
    const types = role === 'pad' ? ['sawtooth', 'sawtooth'] : role === 'arp' ? ['sawtooth', 'square'] : ['square', 'sawtooth'];
    if (role === 'pad') {
      lp.frequency.value = 1400 + 1800 * v;
      stop = adsr(g.gain, t, dur, { a: Math.min(0.6, dur * 0.5), d: 0.4, s: 0.9, r: 0.8, peak: 0.07 * v });
    } else if (role === 'arp') {
      lp.Q.value = 6;
      lp.frequency.setValueAtTime(f * 10, t);
      lp.frequency.setTargetAtTime(f * 2, t, 0.06);
      stop = adsr(g.gain, t, Math.min(dur, 0.25), { a: 0.003, d: 0.12, s: 0.3, r: 0.12, peak: 0.13 * v });
    } else {
      lp.Q.value = 3;
      lp.frequency.setValueAtTime(f * 8, t);
      lp.frequency.setTargetAtTime(f * 3, t, 0.25);
      stop = adsr(g.gain, t, dur, { a: 0.01, d: 0.3, s: 0.7, r: 0.15, peak: 0.11 * v });
    }
    types.forEach((type, i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = i === 0 ? -7 : 7;
      o.connect(lp);
      o.start(t);
      o.stop(stop);
    });
    lp.connect(g).connect(this.out);
  }

  drum(p, t, v, style) {
    const { ctx } = this;
    const out = this.out;
    const noiseHit = (type, freq, decay, gain, q = 0.7, attack = 0.001) => {
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain * v, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      n.connect(f).connect(g).connect(out);
      n.start(t, Math.random() * 1.0, decay + 0.05);
    };
    const toneHit = (type, f0, f1, decay, gain, sweep = 0.05) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain * v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + decay + 0.05);
    };
    const punchy = style === 'edm' || style === 'scifi' || style === 'epic';
    switch (p) {
      case DRUM.kick:
        toneHit('sine', punchy ? 180 : 140, 42, punchy ? 0.6 : 0.42, 0.95, 0.09);
        noiseHit('highpass', 3500, 0.012, 0.25);
        break;
      case DRUM.snare:
      case DRUM.snare2:
        noiseHit('highpass', 1400, 0.2, 0.42);
        toneHit('triangle', 220, 160, 0.09, 0.35, 0.03);
        break;
      case DRUM.clap:
        [0, 0.011, 0.022].forEach((dt) => {
          const tt = t + dt;
          const n = ctx.createBufferSource();
          n.buffer = this.noise;
          const f = ctx.createBiquadFilter();
          f.type = 'bandpass';
          f.frequency.value = 1300;
          f.Q.value = 1.4;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.5 * v, tt);
          g.gain.exponentialRampToValueAtTime(0.0001, tt + (dt === 0.022 ? 0.18 : 0.02));
          n.connect(f).connect(g).connect(out);
          n.start(tt, Math.random(), 0.25);
        });
        break;
      case DRUM.rim:
        toneHit('triangle', 1700, 1500, 0.035, 0.35, 0.01);
        noiseHit('bandpass', 3000, 0.02, 0.2, 2);
        break;
      case DRUM.closedHat:
      case DRUM.pedalHat:
        noiseHit('highpass', 7500, 0.05, 0.16);
        break;
      case DRUM.openHat:
        noiseHit('highpass', 7000, 0.32, 0.13);
        break;
      case DRUM.crash:
      case DRUM.crash2:
      case DRUM.splash:
        noiseHit('highpass', 4500, 1.6, 0.17);
        break;
      case DRUM.china:
        noiseHit('bandpass', 3200, 1.2, 0.28, 1.5);
        break;
      case DRUM.ride:
      case DRUM.rideBell:
        noiseHit('highpass', 6500, 0.55, 0.07);
        toneHit('square', 3150, 3100, 0.25, 0.012, 0.01);
        break;
      case DRUM.shaker:
      case DRUM.tambourine:
        noiseHit('highpass', 8500, 0.07, 0.12, 0.7, 0.012);
        break;
      case DRUM.cowbell:
        toneHit('square', 800, 790, 0.18, 0.06, 0.01);
        toneHit('square', 540, 535, 0.18, 0.06, 0.01);
        break;
      case DRUM.lowTom:
        toneHit('sine', 130, 80, 0.45, 0.7, 0.12);
        break;
      case DRUM.midTom:
        toneHit('sine', 180, 120, 0.38, 0.6, 0.1);
        break;
      case DRUM.highTom:
        toneHit('sine', 240, 170, 0.3, 0.55, 0.1);
        break;
      default:
        noiseHit('bandpass', 2000 + (p % 12) * 400, 0.1, 0.15, 1);
    }
  }
}

// ---------------------------------------------------------------- render
// Stage 1 — dry stems. Notes are rendered in short chunks (each in its own small
// OfflineAudioContext) and overlap-added. Every note is synthesised independently,
// so this is exact — and it keeps the number of live audio nodes small (one huge
// graph gets slower with every note added).
const CHUNK_BARS = 4;

function playNote(voices, name, role, n, t, stepSec, drumStyle) {
  const dur = Math.max(0.05, n.dur * stepSec);
  const v = clamp(n.vel / 127, 0.05, 1);
  switch (name) {
    case 'piano': return voices.piano(n.pitch, t, dur, v);
    case 'guitar': return voices.guitar(n.pitch, t, dur, v);
    case 'bass': return voices.bass(n.pitch, t, dur, v);
    case 'drums': return voices.drum(n.pitch, t, v, drumStyle);
    case 'violin': return voices.bowed(n.pitch, t, dur, v);
    case 'strings': return voices.bowed(n.pitch, t, dur, v, { ensemble: true });
    case 'flute': return voices.flute(n.pitch, t, dur, v);
    case 'synth': return voices.synth(n.pitch, t, dur, v, role);
    default: return null;
  }
}

function addTransitions(ctx, out, noise, plan, chunkStart, chunkEnd, offsetSec) {
  plan.preDrop.forEach((isPre, b) => {
    if (!isPre || b < chunkStart || b >= chunkEnd) return;
    const t0 = b * plan.secondsPerBar + 0.05 - offsetSec;
    const t1 = t0 + plan.secondsPerBar;
    const n = ctx.createBufferSource();
    n.buffer = noise;
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 3;
    bp.frequency.setValueAtTime(300, t0);
    bp.frequency.exponentialRampToValueAtTime(7000, t1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.18, t1 - 0.02);
    g.gain.linearRampToValueAtTime(0, t1);
    n.connect(bp).connect(g).connect(out);
    n.start(t0);
    n.stop(t1 + 0.05);
    const o = ctx.createOscillator(); // sub "impact" on the drop
    o.frequency.setValueAtTime(90, t1);
    o.frequency.exponentialRampToValueAtTime(32, t1 + 1.2);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.35, t1);
    og.gain.exponentialRampToValueAtTime(0.0001, t1 + 1.6);
    o.connect(og).connect(out);
    o.start(t1);
    o.stop(t1 + 1.7);
  });
}

export async function renderStems(song, onProgress) {
  const { plan, tracks, settings } = song;
  const stepSec = plan.secondsPerBar / 16;
  const total = Math.ceil((plan.seconds + 4) * SR);
  const names = [...tracks.map((t) => t.name), 'fx'];
  const stems = Object.fromEntries(names.map((n) => [n, new Float32Array(total)]));
  const nChunks = Math.ceil(plan.bars / CHUNK_BARS);
  for (let c = 0; c < nChunks; c++) {
    const b0 = c * CHUNK_BARS;
    const b1 = Math.min(plan.bars, b0 + CHUNK_BARS);
    const offsetSec = b0 * plan.secondsPerBar;
    const s0 = b0 * 16;
    const s1 = b1 * 16;
    let endSec = (b1 - b0) * plan.secondsPerBar + 2;
    const chunkNotes = tracks.map((t) => t.notes.filter((n) => n.start >= s0 && n.start < s1));
    chunkNotes.forEach((ns) => ns.forEach((n) => (endSec = Math.max(endSec, (n.start + n.dur) * stepSec - offsetSec + 2.2))));
    if (plan.preDrop.slice(b0, b1).some(Boolean)) endSec += 2;
    endSec = Math.min(endSec, total / SR - offsetSec);
    const len = Math.max(1, Math.ceil(endSec * SR));
    const ctx = new OfflineAudioContext(names.length, len, SR);
    const merger = ctx.createChannelMerger(names.length);
    merger.connect(ctx.destination);
    const noise = noiseBuffer(ctx, 2, 3 + c);
    tracks.forEach((t, i) => {
      if (!chunkNotes[i].length) return;
      const bus = ctx.createGain();
      bus.connect(merger, 0, i);
      const voices = new Voices(ctx, bus, { noise });
      for (const n of chunkNotes[i]) playNote(voices, t.name, t.role, n, n.start * stepSec + 0.05 - offsetSec, stepSec, settings.drumStyle);
    });
    const fxBus = ctx.createGain();
    fxBus.connect(merger, 0, names.length - 1);
    addTransitions(ctx, fxBus, noise, plan, b0, b1, offsetSec);
    const out = await ctx.startRendering();
    const off = Math.round(offsetSec * SR);
    names.forEach((n, i) => {
      const src = out.getChannelData(i);
      const dst = stems[n];
      const m = Math.min(src.length, dst.length - off);
      for (let k = 0; k < m; k++) dst[off + k] += src[k];
    });
    onProgress?.((c + 1) / nChunks);
  }
  return { stems, length: total, sampleRate: SR };
}

// Stage 2 — mix: per-track volume, tone, pan, reverb/delay sends, master chain.
// Only a handful of nodes → fast, so mix sliders re-render almost instantly.
export async function mixStems(song, stemData, mix) {
  const { plan, tracks } = song;
  const { stems, length } = stemData;
  const tail = Math.ceil((1 + 2.5 * mix.fx.reverb) * SR);
  const ctx = new OfflineAudioContext(2, length + tail, SR);
  const nyq = SR / 2 - 200;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  const lofiLP = ctx.createBiquadFilter();
  lofiLP.type = 'lowpass';
  lofiLP.frequency.value = Math.min(nyq, 16000 - 12500 * mix.fx.lofi);
  lofiLP.Q.value = 0.5;
  const lofiHP = ctx.createBiquadFilter();
  lofiHP.type = 'highpass';
  lofiHP.frequency.value = 30 + 120 * mix.fx.lofi;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 3;
  comp.attack.value = 0.01;
  comp.release.value = 0.2;
  master.connect(lofiHP).connect(lofiLP).connect(comp).connect(ctx.destination);

  const reverb = ctx.createConvolver();
  reverb.buffer = impulseResponse(ctx, 1.2 + 3.8 * mix.fx.reverb, 2.5, 11);
  const reverbReturn = ctx.createGain();
  reverbReturn.gain.value = 0.55;
  reverb.connect(reverbReturn).connect(master);
  const delay = ctx.createDelay(2);
  delay.delayTime.value = (60 / plan.tempo) * 0.75;
  const fb = ctx.createGain();
  fb.gain.value = 0.32;
  const dlp = ctx.createBiquadFilter();
  dlp.type = 'lowpass';
  dlp.frequency.value = 3000;
  delay.connect(dlp).connect(fb).connect(delay);
  const delayReturn = ctx.createGain();
  delayReturn.gain.value = 0.35 * mix.fx.delay;
  dlp.connect(delayReturn).connect(master);

  const toBuffer = (data) => {
    const b = ctx.createBuffer(1, length, SR);
    b.copyToChannel(data, 0);
    return b;
  };
  for (const track of tracks) {
    const c = mix.instruments[track.name];
    if (!c || c.muted) continue;
    const src = ctx.createBufferSource();
    src.buffer = toBuffer(stems[track.name]);
    const bus = ctx.createGain();
    bus.gain.value = c.volume;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = Math.min(nyq, 500 * Math.pow(2, c.brightness * 5.3));
    const pan = ctx.createStereoPanner();
    pan.pan.value = c.pan;
    src.connect(bus).connect(tone).connect(pan).connect(master);
    const send = ctx.createGain();
    send.gain.value = c.reverb * (0.4 + 0.8 * mix.fx.reverb);
    pan.connect(send).connect(reverb);
    if (['lead', 'arp', 'leadHarmony'].includes(track.role)) {
      const ds = ctx.createGain();
      ds.gain.value = 0.6;
      pan.connect(ds).connect(delay);
    }
    src.start(0);
  }
  if (mix.fx.transitions !== false) {
    const src = ctx.createBufferSource();
    src.buffer = toBuffer(stems.fx);
    src.connect(master);
    src.connect(reverb);
    src.start(0);
  }
  const rendered = await ctx.startRendering();
  const channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
  if (mix.fx.lofi > 0.02) lofiPost(channels, mix.fx.lofi, song.seed);
  normalize(channels, 0.89);
  return { channels, sampleRate: SR, duration: (length + tail) / SR };
}

export async function renderSong(song, mix) {
  return mixStems(song, await renderStems(song), mix);
}

// ---------------------------------------------------------------- post FX
function lofiPost(ch, amt, seed) {
  const rng = makeRng(seed + 99);
  const n = ch[0].length;
  // wow & flutter (tape pitch wobble) via modulated fractional delay
  const depth = 0.0025 * SR * amt;
  const flutter = 0.00025 * SR * amt;
  for (const d of ch) {
    const src = Float32Array.from(d);
    for (let i = 0; i < n; i++) {
      const off = depth * (1 + Math.sin((2 * Math.PI * 0.55 * i) / SR)) + flutter * (1 + Math.sin((2 * Math.PI * 6.3 * i) / SR));
      const pos = i - off;
      const k = Math.floor(pos);
      const f = pos - k;
      d[i] = k >= 0 && k + 1 < n ? src[k] * (1 - f) + src[k + 1] * f : 0;
    }
  }
  // bit reduction + vinyl crackle + hiss
  const levels = Math.pow(2, Math.round(16 - 6 * amt));
  let crackle = 0;
  for (let i = 0; i < n; i++) {
    if (rng.next() < 0.00025 * amt) crackle = (rng.next() * 2 - 1) * 0.5 * amt;
    crackle *= 0.86;
    const hiss = (rng.next() * 2 - 1) * 0.006 * amt;
    for (const d of ch) d[i] = Math.round((d[i] + crackle + hiss) * levels) / levels;
  }
}

function normalize(ch, target) {
  let peak = 0;
  for (const d of ch) for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak < 1e-6) return;
  const g = target / peak;
  for (const d of ch) for (let i = 0; i < d.length; i++) d[i] *= g;
}
