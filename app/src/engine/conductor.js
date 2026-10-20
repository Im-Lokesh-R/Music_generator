// Conductor: builds the shared plan every instrument follows — key, scale, tempo,
// chord per bar, song sections and the per-bar energy ("rise & drop") curve.
// Generating all instruments against ONE plan is what keeps them in harmony.

import { CHORD_TYPES, clamp, lerp, makeRng } from './theory.js';

export const ENERGY_PRESETS = {
  steady: [0.35, 0.5, 0.55, 0.6, 0.6, 0.55, 0.6, 0.6, 0.6, 0.55, 0.6, 0.6, 0.6, 0.55, 0.5, 0.35],
  build: [0.12, 0.18, 0.24, 0.3, 0.36, 0.42, 0.48, 0.54, 0.6, 0.66, 0.72, 0.78, 0.84, 0.9, 0.95, 0.75],
  buildDrop: [0.3, 0.35, 0.45, 0.5, 0.55, 0.65, 0.75, 0.85, 0.08, 1, 1, 0.95, 1, 0.6, 0.45, 0.3],
  wave: [0.3, 0.45, 0.6, 0.7, 0.6, 0.45, 0.35, 0.45, 0.6, 0.75, 0.85, 0.75, 0.6, 0.45, 0.35, 0.25],
  fadeInOut: [0.08, 0.15, 0.25, 0.35, 0.45, 0.55, 0.62, 0.68, 0.7, 0.68, 0.62, 0.55, 0.45, 0.32, 0.2, 0.1],
};

export const ENERGY_LABELS = {
  steady: 'Steady', build: 'Slow build (rise)', buildDrop: 'Build → Drop', wave: 'Waves', fadeInOut: 'Fade in / out',
};

/** Resample a control-point curve to one value per bar (linear interpolation). */
export function curveToBars(points, bars) {
  const out = [];
  for (let b = 0; b < bars; b++) {
    const t = bars === 1 ? 0 : (b / (bars - 1)) * (points.length - 1);
    const i = Math.floor(t);
    const f = t - i;
    out.push(clamp(lerp(points[i], points[Math.min(i + 1, points.length - 1)], f), 0, 1));
  }
  return out;
}

export function barsForDuration(seconds, tempo) {
  const bars = Math.round((seconds * tempo) / 240 / 4) * 4;
  return clamp(bars, 8, 96);
}

function sectionName(energy, prev, next, isFirst, isLast) {
  if (isFirst) return 'Intro';
  if (isLast) return 'Outro';
  if (energy >= 0.78) return 'Drop';
  if (energy < 0.25) return 'Breakdown';
  if (next - prev > 0.12) return 'Build';
  return 'Verse';
}

export function makePlan(settings, energyPoints, durationSec, seed) {
  const rng = makeRng(seed * 31 + 7);
  const bars = barsForDuration(durationSec, settings.tempo);
  const energy = curveToBars(energyPoints, bars);

  // ---- chords ----
  const hr = settings.harmonicRhythm || 1;
  const prog = settings.progression;
  const chords = [];
  for (let b = 0; b < bars; b++) {
    const idx = Math.floor(b / hr) % prog.length;
    let [semi, quality] = prog[idx];
    // Turnaround: at the end of every 8-bar phrase occasionally swap in the V chord
    if (b % 8 === 7 && hr === 1 && rng.chance(0.35) && quality !== 'cluster') {
      semi = 7;
      quality = settings.scale.includes('inor') || settings.scale === 'harmonicMinor' ? 'dom7' : quality;
    }
    if (!CHORD_TYPES[quality]) quality = 'maj';
    chords.push({ root: (settings.key + semi) % 12, quality });
  }

  // ---- sections (groups of 4 bars) ----
  const sections = [];
  const barSection = [];
  const groups = Math.ceil(bars / 4);
  for (let g = 0; g < groups; g++) {
    const s = g * 4;
    const e = Math.min(bars, s + 4);
    const avg = energy.slice(s, e).reduce((a, x) => a + x, 0) / (e - s);
    const prev = energy[Math.max(0, s - 1)];
    const next = energy[Math.min(bars - 1, e)];
    const name = sectionName(avg, prev, next, g === 0, g === groups - 1 && groups > 2);
    const last = sections[sections.length - 1];
    if (last && last.name === name) last.end = e;
    else sections.push({ name, start: s, end: e });
    for (let b = s; b < e; b++) barSection.push(name);
  }

  // A bar right before a big energy jump becomes a "pre-drop" (riser / fill / silence)
  const preDrop = energy.map((e, b) => b < bars - 1 && energy[b + 1] - e > 0.35);
  // Phrase ends get drum fills
  const phraseEnd = energy.map((_, b) => b % 8 === 7 || (b < bars - 1 && barSection[b + 1] !== barSection[b]));

  const secondsPerBar = 240 / settings.tempo;
  return {
    bars,
    tempo: settings.tempo,
    key: settings.key,
    scale: settings.scale,
    swing: settings.swing,
    stepsPerBar: 16,
    secondsPerBar,
    seconds: bars * secondsPerBar,
    chords,
    energy,
    sections,
    barSection,
    preDrop,
    phraseEnd,
  };
}
