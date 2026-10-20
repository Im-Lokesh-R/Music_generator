// End-to-end note generation: settings → Conductor plan → per-instrument tracks
// (Theory engine, Transformer, or Hybrid) → swing/cleanup → critic (best-of-N).

import { makePlan } from './conductor.js';
import { evaluateSong } from './critic.js';
import { INSTRUMENT_ORDER } from './instruments.js';
import { generateTrackML } from './mlGenerator.js';
import { assignRoles, generateTrack } from './procedural.js';

export const ENGINES = {
  theory: 'Theory engine (rule-based)',
  hybrid: 'Hybrid (AI accompaniment + theory melody)',
  ai: 'AI Transformer (all instruments)',
};

const HYBRID_AI = new Set(['drums', 'bass', 'piano', 'guitar']);
const SEED_OFFSET = Object.fromEntries(INSTRUMENT_ORDER.map((n, i) => [n, (i + 1) * 1013]));

function engineFor(name, role, engine, ml) {
  if (!ml || engine === 'theory') return 'theory';
  // instruments the model saw too little of during training fall back to the theory engine
  if (ml.trained && !ml.trained.has(name)) return 'theory';
  if (engine === 'ai') return 'ai';
  return HYBRID_AI.has(name) && role !== 'lead' && role !== 'leadHarmony' ? 'ai' : 'theory';
}

function applySwing(notes, swing) {
  if (!swing) return notes;
  for (const n of notes) {
    const f = n.start % 4;
    if (Math.abs(f - 2) < 0.25) n.start += swing * 2;
    else if (Math.abs(f - 1) < 0.2 || Math.abs(f - 3) < 0.2) n.start += swing;
  }
  return notes;
}

function cleanup(notes, totalSteps) {
  return notes
    .filter((n) => n.start < totalSteps && n.pitch >= 0 && n.pitch <= 127)
    .map((n) => ({ ...n, dur: Math.max(0.25, Math.min(n.dur, totalSteps + 8 - n.start)) }))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

function generateOnce(req, seed, ml, onProgress) {
  const { settings, energyPoints, duration, engine, temperature, keep, only } = req;
  const plan = makePlan(settings, energyPoints, duration, seed);
  const enabled = INSTRUMENT_ORDER.filter((n) => settings.instruments[n].enabled);
  const { roles } = assignRoles(settings, enabled);
  // lead first so the counter-melody can answer it
  const order = [...enabled].sort((a, b) => (roles[a] === 'lead' || roles[a] === 'leadHarmony' ? -1 : 0) - (roles[b] === 'lead' || roles[b] === 'leadHarmony' ? -1 : 0));
  const tracks = [];
  let leadNotes = [];
  order.forEach((name, i) => {
    const role = roles[name];
    const controls = settings.instruments[name];
    const reuse = keep && keep.find((t) => t.name === name) && (!only || only !== name);
    let notes;
    let eng;
    if (reuse) {
      const t = keep.find((k) => k.name === name);
      notes = t.notes.map((n) => ({ ...n }));
      eng = t.engine;
    } else {
      eng = engineFor(name, role, engine, ml);
      const s = seed + SEED_OFFSET[name] + (only === name ? (req.variation || 1) * 7777 : 0);
      if (eng === 'ai') {
        onProgress?.({ stage: `AI composing ${name}`, frac: i / order.length });
        notes = generateTrackML(ml.model, ml.tok, name, plan, settings, controls, s, { temperature, topK: 16 });
      } else {
        notes = generateTrack(name, role, plan, settings, controls, s, { leadNotes });
      }
      notes = applySwing(notes, plan.swing);
    }
    notes = cleanup(notes, plan.bars * 16);
    if (role === 'lead' || role === 'leadHarmony') leadNotes = notes;
    tracks.push({ name, role, engine: eng, notes });
  });
  tracks.sort((a, b) => INSTRUMENT_ORDER.indexOf(a.name) - INSTRUMENT_ORDER.indexOf(b.name));
  const song = { plan, tracks, settings, seed };
  song.critic = evaluateSong(song);
  return song;
}

/**
 * req: { settings, energyPoints, duration, seed, engine, temperature, candidates, keep?, only? }
 * ml:  { model, tok } or null
 */
export function generateSong(req, ml = null, onProgress = null) {
  const usesAI = ml && req.engine !== 'theory';
  const n = req.keep ? 1 : Math.max(1, req.candidates ?? (usesAI ? 1 : 4));
  let best = null;
  const all = [];
  for (let k = 0; k < n; k++) {
    onProgress?.({ stage: `Composing candidate ${k + 1}/${n}`, frac: k / n });
    const song = generateOnce(req, req.seed + k * 101, ml, onProgress);
    all.push({ seed: song.seed, score: song.critic.score });
    if (!best || song.critic.score > best.critic.score) best = song;
  }
  best.candidates = all;
  return best;
}
