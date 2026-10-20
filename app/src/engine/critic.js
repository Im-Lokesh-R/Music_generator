// Critic: objective quality + mood-match metrics. Used to rank best-of-N candidates
// and shown in the UI / report (metrics follow MusPy-style definitions).

import { INSTRUMENTS } from './instruments.js';
import { chordPitchClasses, clamp, scalePitchClasses } from './theory.js';
import { barTargets } from './mlGenerator.js';

const MAJORISH = new Set(['maj', 'maj7', 'dom7', 'maj9', 'add9', 'power', 'sus2', 'sus4']);

export function evaluateSong(song) {
  const { plan, tracks, settings } = song;
  const scale = new Set(scalePitchClasses(plan.key, plan.scale));
  let pitched = 0;
  let inKey = 0;
  let strong = 0;
  let strongChord = 0;
  const pcHist = new Array(12).fill(0);
  const densErr = [];
  let emptyBars = 0;
  let totalBars = 0;
  let velSum = 0;
  let velN = 0;
  let pitchSum = 0;

  for (const t of tracks) {
    const perBar = new Array(plan.bars).fill(0);
    for (const n of t.notes) {
      const b = Math.min(plan.bars - 1, Math.floor(n.start / 16));
      perBar[b]++;
      velSum += n.vel;
      velN++;
      if (t.name === 'drums') continue;
      pitched++;
      pitchSum += n.pitch;
      const pc = n.pitch % 12;
      pcHist[pc]++;
      const chordPcs = chordPitchClasses(plan.chords[b]);
      if (scale.has(pc) || chordPcs.includes(pc)) inKey++;
      if (Math.abs(n.start % 4) < 0.2) {
        strong++;
        if (chordPcs.includes(pc)) strongChord++;
      }
    }
    // control accuracy = does the part follow the energy curve (correlation) and is its
    // note count in the right ballpark for the density slider (log-ratio calibration)?
    const targets = [];
    for (let b = 0; b < plan.bars; b++) {
      targets.push(barTargets(t.name, plan, settings.instruments[t.name], b).n);
      totalBars++;
      if (perBar[b] === 0) emptyBars++;
    }
    const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const mt = avg(targets);
    const ma = avg(perBar);
    const notesPerOnset = t.role === 'rhythm' || t.role === 'harmony' || t.role === 'pad' || t.role === 'leadHarmony' ? 3 : 1;
    const cal = 1 - Math.min(1, Math.abs(Math.log2((ma / notesPerOnset + 1) / (mt + 1))) / 2);
    let cov = 0;
    let vt = 0;
    let va = 0;
    targets.forEach((x, b) => {
      cov += (x - mt) * (perBar[b] - ma);
      vt += (x - mt) ** 2;
      va += (perBar[b] - ma) ** 2;
    });
    const r = vt > plan.bars * 0.25 && va > 0 ? cov / Math.sqrt(vt * va) : null;
    densErr.push(1 - (r === null ? cal : 0.5 * Math.max(0, r) + 0.5 * cal));
  }
  const total = pcHist.reduce((s, x) => s + x, 0) || 1;
  const entropy = -pcHist.reduce((s, x) => (x ? s + (x / total) * Math.log2(x / total) : s), 0);

  // Structure: how often the lead's 1-bar rhythm repeats (motif coherence)
  const lead = tracks.find((t) => t.role === 'lead' || t.role === 'leadHarmony') || tracks[0];
  let structure = 0.5;
  if (lead) {
    const patterns = new Map();
    for (const n of lead.notes) {
      const b = Math.floor(n.start / 16);
      const key = patterns.get(b) || [];
      key.push(Math.round(n.start % 16));
      patterns.set(b, key);
    }
    const sigs = [...patterns.values()].map((p) => [...new Set(p)].join(','));
    const counts = sigs.reduce((m, s) => m.set(s, (m.get(s) || 0) + 1), new Map());
    const repeated = sigs.filter((s) => counts.get(s) > 1).length;
    structure = sigs.length ? repeated / sigs.length : 0.5;
    structure = 1 - Math.abs(structure - 0.6) / 0.6; // ideal: some repetition, not all
  }

  // Mood estimate from musical features → valence/arousal
  const majorRatio = plan.chords.filter((c) => MAJORISH.has(c.quality)).length / plan.chords.length;
  const notesPerBar = tracks.reduce((s, t) => s + t.notes.length, 0) / plan.bars;
  const meanVel = velN ? velSum / velN : 64;
  const meanPitch = pitched ? pitchSum / pitched : 60;
  const minorScale = ['minor', 'harmonicMinor', 'phrygian', 'locrian', 'minorPentatonic', 'dorian'].includes(plan.scale);
  const estValence = clamp((majorRatio - 0.5) * 1.4 + (minorScale ? -0.35 : 0.3) + (meanPitch - 62) / 40 - (1 - inKey / Math.max(1, pitched)) * 2, -1, 1);
  const estArousal = clamp((plan.tempo - 95) / 45 + (notesPerBar - 18) / 40 + (meanVel - 70) / 70, -1, 1);
  const dist = Math.hypot(estValence - settings.valence, estArousal - settings.arousal);

  const metrics = {
    scaleConsistency: pitched ? inKey / pitched : 1,
    chordToneOnBeats: strong ? strongChord / strong : 1,
    controlAccuracy: clamp(1 - densErr.reduce((s, x) => s + x, 0) / Math.max(1, densErr.length), 0, 1),
    pitchClassEntropy: entropy,
    structure: clamp(structure, 0, 1),
    emptyBarRate: totalBars ? emptyBars / totalBars : 0,
    moodMatch: clamp(1 - dist / 2, 0, 1),
    estValence,
    estArousal,
  };
  const score =
    0.25 * metrics.scaleConsistency +
    0.15 * metrics.chordToneOnBeats +
    0.2 * metrics.controlAccuracy +
    0.15 * metrics.structure +
    0.25 * metrics.moodMatch -
    0.1 * Math.max(0, metrics.emptyBarRate - 0.35);
  return { score: clamp(score, 0, 1), metrics };
}

export const METRIC_INFO = {
  scaleConsistency: 'Share of notes inside the key (or the current chord).',
  chordToneOnBeats: 'Share of on-beat notes that are chord tones (harmonic fit).',
  controlAccuracy: 'How well each part follows the rise/drop curve (correlation) and the density slider (note-count calibration).',
  pitchClassEntropy: 'Tonal variety in bits (0 = one note, 3.58 = all 12 equally).',
  structure: 'Motif repetition in the lead (repetition makes music memorable).',
  emptyBarRate: 'Share of silent instrument-bars (arrangement space).',
  moodMatch: 'Distance between requested and estimated valence/arousal.',
};

export { INSTRUMENTS };
