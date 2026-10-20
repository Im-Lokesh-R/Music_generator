// Procedural (music-theory) generator. Produces note lists for each instrument from
// the Conductor plan. Used on its own ("Theory engine"), as the fallback when no
// trained model is loaded, and for drums/bass in "Hybrid" mode.
//
// Note format: { pitch, start, dur, vel }  — start/dur in 16th-note steps (float).

import { INSTRUMENTS, DRUM } from './instruments.js';
import {
  CHORD_TYPES, chordPitchClasses, clamp, lerp, makeRng, pitchesInRange, scalePitchClasses, voiceChord,
} from './theory.js';

const MELODIC = ['violin', 'flute', 'synth', 'piano', 'guitar'];

/** Decide which enabled instrument plays the lead melody and what everyone else does. */
export function assignRoles(settings, enabled) {
  const roles = {};
  const lead = (settings.leadOrder || []).concat(MELODIC).find((n) => enabled.includes(n) && MELODIC.includes(n));
  for (const n of enabled) roles[n] = INSTRUMENTS[n].role;
  if (lead) roles[lead] = 'lead';
  for (const n of enabled) {
    if (n === lead) continue;
    if (n === 'violin' || n === 'flute') roles[n] = 'counter';
    if (n === 'synth') roles[n] = settings.instruments.synth.density < 0.35 ? 'pad' : 'arp';
  }
  // piano alone (or as lead) also keeps its harmony part
  if (lead === 'piano') roles.piano = 'leadHarmony';
  return { roles, lead };
}

function ctxFor(name, plan, settings, controls, rng) {
  const inst = INSTRUMENTS[name];
  const shift = 12 * (controls.register || 0);
  const lo = clamp(inst.range[0] + Math.min(0, shift), 21, 108);
  const hi = clamp(inst.range[1] + Math.max(0, shift), 21, 108);
  const center = clamp(inst.center + shift, lo + 5, hi - 5);
  const scalePcs = scalePitchClasses(plan.key, plan.scale);
  const energyAt = (b) => lerp(0.6, plan.energy[b], controls.energyFollow ?? 0.8);
  const velAt = (b, accent = 1) =>
    Math.round(clamp(127 * (0.22 + 0.62 * controls.velocity) * (0.62 + 0.5 * energyAt(b)) * accent + rng.gauss() * 5, 12, 127));
  return { inst, lo, hi, center, scalePcs, energyAt, velAt, d: controls.density, rng, plan, settings, controls };
}

// ---------------------------------------------------------------- drums
const DRUM_PATTERNS = {
  // per style: [low, mid, high] each { voice: '16-step pattern' } ; 'x' = hit, 'o' = soft hit
  pop: [
    { kick: 'x.......x.......', closedHat: 'x...x...x...x...' },
    { kick: 'x.......x.x.....', snare: '....x.......x...', closedHat: 'x.x.x.x.x.x.x.x.' },
    { kick: 'x.....x.x.x.....', snare: '....x.......x..o', closedHat: 'xoxoxoxoxoxoxoxo', openHat: '..............x.' },
  ],
  lofi: [
    { kick: 'x.........x.....', rim: '....x.......x...', closedHat: 'x...x...x...x...' },
    { kick: 'x......x..x.....', snare: '....x.......x...', closedHat: 'x.x.x.x.x.x.x.x.' },
    { kick: 'x......x.xx.....', snare: '....x.......x..o', closedHat: 'x.xox.x.x.xox.x.', shaker: '..o...o...o...o.' },
  ],
  edm: [
    { kick: 'x...x...x...x...', closedHat: '..x...x...x...x.' },
    { kick: 'x...x...x...x...', clap: '....x.......x...', openHat: '..x...x...x...x.' },
    { kick: 'x...x...x...x...', clap: '....x.......x...', openHat: '..x...x...x...x.', closedHat: 'oxoxoxoxoxoxoxox' },
  ],
  epic: [
    { lowTom: 'x.......x.......', kick: 'x...............' },
    { kick: 'x.....x.x.......', lowTom: 'x..x..x.x..x..x.', snare: '............x...' },
    { kick: 'x.x...x.x.x...x.', snare: '....x.......x...', midTom: 'x..x..x.....x.x.', lowTom: '......x.x.......', crash: 'x...............' },
  ],
  horror: [
    { kick: 'x..x............', rim: '..........o.....' },
    { kick: 'x..x....x..x....', lowTom: '............o...', rim: '......o.......o.' },
    { kick: 'x..x....x..x....', lowTom: 'x.......x.......', china: '........x.......', snare: '............x...' },
  ],
  scifi: [
    { kick: 'x.........x.....', shaker: 'o.o.o.o.o.o.o.o.' },
    { kick: 'x.....x...x.....', clap: '....x.......x...', closedHat: 'xoooxoooxoooxooo' },
    { kick: 'x.....x...x...x.', clap: '....x.......x...', closedHat: 'xoxoxoxoxoxoxoxo', openHat: '......x.......x.' },
  ],
  jazz: [
    { ride: 'x...x..ox...x..o', pedalHat: '....x.......x...' },
    { ride: 'x...x..ox...x..o', pedalHat: '....x.......x...', kick: 'o.......o.......', snare: '.......o.....o..' },
    { ride: 'x...x..xx...x..x', pedalHat: '....x.......x...', kick: 'o.....o.o.......', snare: '...o...o..o..o..' },
  ],
  ballad: [
    { kick: 'x...............', closedHat: 'o...o...o...o...' },
    { kick: 'x.......x.......', rim: '........x.......', closedHat: 'o.o.o.o.o.o.o.o.' },
    { kick: 'x.......x.x.....', snare: '....x.......x...', closedHat: 'x.o.x.o.x.o.x.o.' },
  ],
  rock: [
    { kick: 'x.......x.......', closedHat: 'x.x.x.x.x.x.x.x.' },
    { kick: 'x.......x.x.....', snare: '....x.......x...', closedHat: 'x.x.x.x.x.x.x.x.' },
    { kick: 'x.x.....x.x.....', snare: '....x.......x...', crash: 'x...............', ride: 'x.x.x.x.x.x.x.x.' },
  ],
};
DRUM_PATTERNS.none = DRUM_PATTERNS.ballad;

function genDrums(c) {
  const { plan, settings, rng, d } = c;
  const style = DRUM_PATTERNS[settings.drumStyle] || DRUM_PATTERNS.pop;
  const notes = [];
  const human = settings.drumStyle === 'edm' || settings.drumStyle === 'scifi' ? 0.01 : 0.06;
  const hit = (voice, step, vel) =>
    notes.push({ pitch: DRUM[voice], start: Math.max(0, step + rng.gauss() * human), dur: 1, vel: clamp(Math.round(vel), 10, 127) });

  for (let b = 0; b < plan.bars; b++) {
    const e = c.energyAt(b);
    const level = e * (0.55 + d);
    if (level < 0.12 && !plan.preDrop[b]) continue;
    const base = b * 16;
    const sectionStart = b === 0 || plan.barSection[b] !== plan.barSection[b - 1];

    if (plan.preDrop[b]) {
      // build-up: snare roll accelerating then silence before the drop
      if (settings.drumStyle !== 'horror' && settings.drumStyle !== 'jazz') {
        for (let s = 0; s < 14; s += s < 8 ? 2 : 1) hit('snare', base + s, c.velAt(b, 0.5 + s / 20));
      } else {
        hit('lowTom', base, c.velAt(b, 1.1));
      }
      continue;
    }
    const pat = style[level < 0.4 ? 0 : level < 0.75 ? 1 : 2];
    for (const [voice, p] of Object.entries(pat)) {
      for (let s = 0; s < 16; s++) {
        if (p[s] === '.') continue;
        if (plan.phraseEnd[b] && s >= 12 && e > 0.3 && voice !== 'kick') continue; // leave room for fill
        const accent = (p[s] === 'o' ? 0.55 : 1) * (s % 4 === 0 ? 1.05 : 0.92) * (voice.includes('Hat') || voice === 'shaker' ? 0.75 : 1);
        hit(voice, base + s, c.velAt(b, accent));
      }
    }
    if (sectionStart && e > 0.5 && b > 0) hit('crash', base, c.velAt(b, 1.1));
    if (plan.phraseEnd[b] && e > 0.3) {
      const fill = rng.pick([
        [['snare', 12], ['snare', 13], ['snare', 14], ['snare', 15]],
        [['highTom', 12], ['midTom', 13], ['lowTom', 14], ['lowTom', 15]],
        [['snare', 12], ['snare', 14], ['highTom', 15]],
        [['snare', 13], ['midTom', 14], ['lowTom', 15]],
      ]);
      fill.forEach(([v, s], i) => hit(settings.drumStyle === 'jazz' ? 'snare' : v, base + s, c.velAt(b, 0.75 + i * 0.1)));
    }
  }
  return notes;
}

// ---------------------------------------------------------------- bass
function nearestPitch(pc, center, lo, hi) {
  let best = null;
  for (let p = lo; p <= hi; p++) if (((p % 12) + 12) % 12 === pc && (best === null || Math.abs(p - center) < Math.abs(best - center))) best = p;
  return best ?? center;
}

function genBass(c) {
  const { plan, settings, rng, d } = c;
  const notes = [];
  const add = (pitch, step, dur, vel) => notes.push({ pitch, start: step, dur, vel });
  for (let b = 0; b < plan.bars; b++) {
    const e = c.energyAt(b);
    const level = e * (0.5 + d);
    if (level < 0.1) continue;
    const ch = plan.chords[b];
    const next = plan.chords[Math.min(plan.bars - 1, b + 1)];
    const root = nearestPitch(ch.root, c.center, c.lo, c.hi);
    const fifth = root + 7 <= c.hi ? root + 7 : root - 5;
    const third = root + CHORD_TYPES[ch.quality][1];
    const base = b * 16;
    if (plan.preDrop[b]) {
      add(root, base, 8, c.velAt(b, 0.8));
      continue;
    }
    const style = settings.drumStyle;
    if (style === 'jazz' && level > 0.3) {
      // walking bass: root, chord tone, scale tone, chromatic approach into next root
      const nextRoot = nearestPitch(next.root, root, c.lo, c.hi);
      const scale = pitchesInRange(c.scalePcs, root - 3, root + 9);
      const p2 = rng.pick([third, fifth, root + 12 <= c.hi ? root + 12 : fifth]);
      const p3 = rng.pick(scale.length ? scale : [fifth]);
      const p4 = nextRoot + (rng.chance(0.5) ? 1 : -1);
      [root, p2, p3, p4].forEach((p, i) => add(clamp(p, c.lo, c.hi), base + i * 4, 3.6, c.velAt(b, i === 0 ? 1 : 0.85)));
    } else if (style === 'edm' && level > 0.4) {
      for (let s = 2; s < 16; s += 4) add(root, base + s, 2, c.velAt(b, 1));
      if (level > 0.8) for (let s = 0; s < 16; s += 4) add(root - 12 >= c.lo ? root - 12 : root, base + s, 1, c.velAt(b, 0.7));
    } else if (level < 0.4) {
      add(root, base, settings.harmonicRhythm > 1 ? 16 : 14, c.velAt(b, 0.95));
    } else if (level < 0.75) {
      const pat = rng.pick([
        [[0, 6, root], [6, 2, root], [8, 6, fifth], [14, 2, root]],
        [[0, 7, root], [7, 3, fifth], [10, 6, root]],
        [[0, 4, root], [4, 4, root], [8, 4, fifth], [12, 4, third]],
      ]);
      pat.forEach(([s, du, p]) => add(p, base + s, du, c.velAt(b, s === 0 ? 1 : 0.85)));
    } else {
      // driving 8ths with octave pops
      for (let s = 0; s < 16; s += 2) {
        const p = s % 8 === 6 && root + 12 <= c.hi ? root + 12 : s === 14 ? fifth : root;
        add(p, base + s, 1.8, c.velAt(b, s % 4 === 0 ? 1 : 0.8));
      }
    }
  }
  return notes;
}

// ---------------------------------------------------------------- harmony (piano / guitar / pads)
function genHarmony(c, mode) {
  const { plan, settings, rng, d } = c;
  const notes = [];
  let prev = null;
  const add = (pitch, step, dur, vel) => pitch >= c.lo - 12 && pitch <= c.hi && notes.push({ pitch, start: step, dur, vel });
  const center = mode === 'leadHarmony' ? c.center - 8 : c.center;
  const style = settings.drumStyle;
  for (let b = 0; b < plan.bars; b++) {
    const e = c.energyAt(b);
    const level = e * (0.5 + d);
    const ch = plan.chords[b];
    const base = b * 16;
    const count = CHORD_TYPES[ch.quality].length >= 4 ? 4 : 3 + (level > 0.6 ? 1 : 0);
    const v = voiceChord(ch, center, count, prev);
    prev = v;
    if (plan.preDrop[b]) {
      v.forEach((p) => add(p, base, 8, c.velAt(b, 0.7)));
      continue;
    }
    if (style === 'horror' || settings.primaryMood === 'horror') {
      // dark sustained low chord + sparse high "plinks"
      v.forEach((p) => add(p - 12, base, 16, c.velAt(b, 0.75)));
      const nPlinks = Math.round(d * 4 * (0.3 + e));
      const high = pitchesInRange(c.scalePcs.concat(chordPitchClasses(ch)), c.center + 12, Math.min(c.hi + 12, 100));
      for (let i = 0; i < nPlinks; i++) add(rng.pick(high), base + rng.int(0, 15), rng.int(2, 6), c.velAt(b, 0.6));
      continue;
    }
    if (style === 'jazz' || (style === 'lofi' && level > 0.25)) {
      // syncopated comping with a light roll
      const choices = level > 0.6 ? [[[0, 5], [6, 3], [10, 6]], [[2, 4], [7, 3], [11, 5]]] : [[[0, 9], [10, 6]], [[0, 7], [7, 9]]];
      const pat = rng.pick(choices);
      pat.forEach(([s, du]) => v.forEach((p, i) => add(p, base + s + i * 0.08, du, c.velAt(b, i === v.length - 1 ? 0.95 : 0.8))));
      if (mode !== 'leadHarmony' && !settings.instruments.bass.enabled) add(nearestPitch(ch.root, center - 17, 28, 60), base, 14, c.velAt(b, 0.85));
      continue;
    }
    if (level < 0.35) {
      // sustained block chord (or two halves)
      const halves = settings.harmonicRhythm === 1 && rng.chance(0.4);
      if (halves) [0, 8].forEach((s) => v.forEach((p) => add(p, base + s, 8, c.velAt(b, s ? 0.75 : 0.85))));
      else v.forEach((p, i) => add(p, base + i * 0.12, 16, c.velAt(b, 0.8)));
    } else if (level < 0.72) {
      // broken-chord arpeggio in 8ths
      const order = rng.pick([[0, 1, 2, 3, 2, 1, 0, 1], [0, 2, 1, 3, 0, 2, 1, 3], [0, 1, 2, 1, 3, 1, 2, 1]]);
      order.forEach((k, i) => add(v[k % v.length], base + i * 2, 2.6, c.velAt(b, i % 2 === 0 ? 0.85 : 0.7)));
      add(v[0] - 12, base, 16, c.velAt(b, 0.75));
    } else {
      // rhythmic chords (pop/rock syncopation) + left-hand octave
      const pat = rng.pick([[0, 3, 6, 10, 12], [0, 3, 8, 11, 14], [0, 4, 6, 10, 12, 14]]);
      pat.forEach((s, i) => v.forEach((p) => add(p, base + s, i === pat.length - 1 ? 16 - s : 2.5, c.velAt(b, s % 4 === 0 ? 0.95 : 0.8))));
      add(v[0] - 12, base, 8, c.velAt(b, 0.9));
      add(v[0] - 12, base + 8, 8, c.velAt(b, 0.85));
    }
  }
  return notes;
}

function genGuitar(c) {
  const { plan, rng, d, settings } = c;
  const notes = [];
  let prev = null;
  for (let b = 0; b < plan.bars; b++) {
    const e = c.energyAt(b);
    const level = e * (0.5 + d);
    if (level < 0.12) continue;
    const ch = plan.chords[b];
    const base = b * 16;
    const v = voiceChord(ch, c.center, 5, prev, 19);
    prev = v;
    const strum = (step, dur, down, accent) => {
      const vs = down ? v : [...v].reverse().slice(0, 4);
      vs.forEach((p, i) => notes.push({ pitch: p, start: base + step + i * 0.07, dur, vel: c.velAt(b, accent * (down ? 1 : 0.8)) }));
    };
    if (plan.preDrop[b]) {
      strum(0, 8, true, 0.9);
      continue;
    }
    if (level < 0.35 || ['sad', 'soft', 'romantic'].includes(settings.primaryMood)) {
      // fingerpicking: bass + plucked chord tones
      const pick = [0, 2, 3, 1, 4, 2, 3, 1];
      pick.forEach((k, i) => notes.push({ pitch: v[k % v.length], start: base + i * 2, dur: 3.5, vel: c.velAt(b, i % 4 === 0 ? 0.9 : 0.7) }));
    } else if (level < 0.75) {
      // folk pattern D . D U . U D U
      [[0, 1], [4, 1], [6, 0], [10, 0], [12, 1], [14, 0]].forEach(([s, down]) => strum(s, 2.5, down, s % 4 === 0 ? 1 : 0.8));
    } else {
      for (let s = 0; s < 16; s += 2) strum(s, 1.6, s % 4 === 0, s % 4 === 0 ? 1 : 0.75);
    }
  }
  return notes;
}

function genPad(c, tremolo) {
  const { plan, d, rng } = c;
  const notes = [];
  let prev = null;
  for (let b = 0; b < plan.bars; b++) {
    const e = c.energyAt(b);
    const ch = plan.chords[b];
    const base = b * 16;
    const v = voiceChord(ch, c.center, 4, prev, 14);
    const same = prev && b > 0 && plan.chords[b - 1].root === ch.root && plan.chords[b - 1].quality === ch.quality;
    prev = v;
    if (plan.preDrop[b]) {
      // riser: rising long note that swells into the drop
      notes.push({ pitch: v[v.length - 1], start: base, dur: 16, vel: c.velAt(b, 1.1) });
      continue;
    }
    if (tremolo) {
      for (let s = 0; s < 16; s += 1) [v[0], v[0] + 1].forEach((p) => notes.push({ pitch: p, start: base + s, dur: 0.9, vel: c.velAt(b, 0.45 + 0.02 * s) }));
      notes.push({ pitch: v[2] + 12, start: base, dur: 16, vel: c.velAt(b, 0.6) });
      continue;
    }
    if (e * (0.5 + d) > 0.85) {
      // epic ostinato: 8th-note spiccato on root/fifth + sustained top
      for (let s = 0; s < 16; s += 2) notes.push({ pitch: s % 4 === 0 ? v[0] : v[1], start: base + s, dur: 1.6, vel: c.velAt(b, s % 4 === 0 ? 0.95 : 0.8) });
      notes.push({ pitch: v[3] ?? v[2], start: base, dur: 16, vel: c.velAt(b, 0.85) });
      continue;
    }
    if (same && notes.length) {
      // tie into previous chord — extend the previous notes instead of re-attacking
      for (const n of notes) if (n.start + n.dur >= base - 0.01 && n.dur >= 12) n.dur += 16;
      continue;
    }
    v.forEach((p) => notes.push({ pitch: p, start: base + rng.float(0, 0.15), dur: 16, vel: c.velAt(b, 0.8) }));
  }
  return notes;
}

function genArp(c) {
  const { plan, rng, d } = c;
  const notes = [];
  const pattern = rng.pick(['up', 'updown', 'random', 'pingpong']);
  let prev = null;
  for (let b = 0; b < plan.bars; b++) {
    const e = c.energyAt(b);
    const level = e * (0.5 + d);
    if (level < 0.25) continue;
    const ch = plan.chords[b];
    const base = b * 16;
    const v = voiceChord(ch, c.center, 4, prev, 14);
    prev = v;
    const tones = [...v, v[0] + 12];
    const stepLen = level > 0.65 ? 1 : 2;
    let i = 0;
    for (let s = 0; s < (plan.preDrop[b] ? 12 : 16); s += stepLen, i++) {
      let k;
      if (pattern === 'up') k = i % tones.length;
      else if (pattern === 'updown') {
        const cyc = tones.length * 2 - 2;
        const m = i % cyc;
        k = m < tones.length ? m : cyc - m;
      } else if (pattern === 'pingpong') k = i % 2 === 0 ? 0 : 1 + ((i >> 1) % (tones.length - 1));
      else k = rng.int(0, tones.length - 1);
      notes.push({ pitch: tones[k], start: base + s, dur: stepLen * 0.85, vel: c.velAt(b, s % 4 === 0 ? 0.95 : 0.75) });
    }
  }
  return notes;
}

// ---------------------------------------------------------------- melody (lead / counter)
function onsetGrid(rng, count, longNotes) {
  // weighted 16-step grid favouring strong beats
  const w = [10, 1, 3, 1, 7, 1, 3, 1, 9, 1, 3, 1, 7, 1, 3, 2].map((x, i) => (i % 2 === 1 ? x * (1 - longNotes) : x));
  const chosen = new Set();
  let guard = 0;
  while (chosen.size < count && guard++ < 200) chosen.add(rng.weighted([...Array(16).keys()], w));
  return [...chosen].sort((a, b) => a - b);
}

function genMelody(c, opts = {}) {
  const { plan, settings, rng, d } = c;
  const mel = settings.melody;
  const notes = [];
  const counter = opts.counter;
  const avoid = opts.avoidNotes || [];
  const lo = Math.max(c.lo, c.center - 9);
  const hi = Math.min(c.hi, c.center + 12);
  const chromaticP = settings.chromaticism * 0.25;

  // Motif bank: a 2-bar rhythm + interval contour, reused across phrases (A A' B A'')
  const makeMotif = () => {
    const bars = [];
    for (let k = 0; k < 2; k++) {
      const count = clamp(Math.round(INSTRUMENTS.violin.maxNotesPerBar * (0.15 + d) * (counter ? 0.75 : 1.25) * (1 - mel.longNotes * 0.45)), 2, 10);
      bars.push(onsetGrid(rng, count, mel.longNotes));
    }
    const contour = Array.from({ length: 24 }, () => (rng.chance(mel.step) ? rng.pick([-1, 1, 1, -1, -2, 2]) : rng.pick([-4, -3, 3, 4, 5])));
    return { bars, contour };
  };
  const motifA = makeMotif();
  const motifB = makeMotif();

  let current = c.center;
  let ci = 0;
  for (let b = 0; b < plan.bars; b++) {
    const e = c.energyAt(b);
    const gate = counter ? 0.45 : 0.22;
    if (e < gate && plan.bars > 8) {
      continue; // rest during low-energy sections (arrangement)
    }
    if (plan.preDrop[b]) continue;
    const ch = plan.chords[b];
    const chordPcs = chordPitchClasses(ch);
    const allowedPcs = [...new Set([...c.scalePcs, ...chordPcs])];
    const chordTones = pitchesInRange(chordPcs, lo, hi);
    const scaleTones = pitchesInRange(allowedPcs, lo, hi);
    const phrasePos = (b % 8) >> 1; // 0..3 → A A' B A''
    const motif = phrasePos === 2 ? motifB : motifA;
    let onsets = motif.bars[b % 2];
    if (phrasePos === 1 || phrasePos === 3) {
      // variation: drop / add one onset
      onsets = onsets.filter(() => !rng.chance(0.15));
      if (rng.chance(0.3)) onsets = [...new Set([...onsets, rng.pick([2, 6, 10, 14])])].sort((x, y) => x - y);
    }
    if (counter) {
      // counter-melody fills the gaps the lead leaves
      const leadOn = new Set(avoid.filter((n) => n.start >= b * 16 && n.start < b * 16 + 16).map((n) => Math.round(n.start - b * 16)));
      onsets = onsets.filter((s) => !leadOn.has(s) && !leadOn.has(s + 1));
      if (!onsets.length && rng.chance(0.5)) onsets = [8];
    }
    if (b % 2 === 0) ci = 0;
    for (let k = 0; k < onsets.length; k++) {
      const s = onsets[k];
      if (rng.chance(mel.rest * 0.35)) continue;
      const nextOn = k + 1 < onsets.length ? onsets[k + 1] : 16;
      let dur = Math.max(1, nextOn - s - (rng.chance(0.3) ? 1 : 0));
      // phrase ending: long note on a chord tone
      const phraseEnd = b % 4 === 3 && k === onsets.length - 1;
      if (phraseEnd) dur = 16 - s;
      let target;
      if (s % 4 === 0 || phraseEnd) {
        // strong beat → nearest chord tone in the direction of the contour
        const want = current + motif.contour[ci % motif.contour.length];
        target = chordTones.reduce((best, p) => (Math.abs(p - want) < Math.abs(best - want) ? p : best), chordTones[0] ?? current);
      } else {
        // weak beat → step through the scale following the motif's contour
        const steps = motif.contour[ci % motif.contour.length];
        const idx = scaleTones.findIndex((p) => p >= current);
        const j = clamp((idx < 0 ? scaleTones.length - 1 : idx) + steps, 0, scaleTones.length - 1);
        target = scaleTones[j];
        if (rng.chance(chromaticP)) target += rng.pick([-1, 1]);
      }
      ci++;
      // keep the line inside its range with a gentle pull to the centre
      if (target > hi) target -= 12;
      if (target < lo) target += 12;
      if (Math.abs(target - c.center) > 10 && rng.chance(0.5)) target += target > c.center ? -12 : 12;
      if (target > hi || target < lo) target = clamp(target, lo, hi);
      current = target;
      notes.push({ pitch: target, start: b * 16 + s, dur, vel: c.velAt(b, s % 4 === 0 ? 1 : 0.85) });
      // harmonise a diatonic third above at climaxes (lead only)
      if (!counter && e > 0.82 && s % 4 === 0 && rng.chance(0.5)) {
        const above = scaleTones.find((p) => p >= target + 3 && p <= target + 4);
        if (above) notes.push({ pitch: above, start: b * 16 + s, dur, vel: c.velAt(b, 0.75) });
      }
    }
  }
  return notes;
}

// ---------------------------------------------------------------- entry
export function generateTrack(name, role, plan, settings, controls, seed, extras = {}) {
  const rng = makeRng(seed);
  const c = ctxFor(name, plan, settings, controls, rng);
  switch (role) {
    case 'drums':
      return genDrums(c);
    case 'bass':
      return genBass(c);
    case 'rhythm':
      return genGuitar(c);
    case 'pad':
      return genPad(c, name === 'strings' && settings.primaryMood === 'horror' && controls.density > 0.4);
    case 'arp':
      return genArp(c);
    case 'counter':
      return genMelody(c, { counter: true, avoidNotes: extras.leadNotes });
    case 'lead':
      return genMelody(c);
    case 'leadHarmony':
      return [...genHarmony(c, 'leadHarmony'), ...genMelody(c)];
    case 'harmony':
    default:
      return genHarmony(c, 'harmony');
  }
}
