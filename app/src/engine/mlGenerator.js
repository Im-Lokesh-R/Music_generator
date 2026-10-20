// Transformer-based track generation with CONSTRAINED decoding.
//
// For every bar we force the control tokens the Conductor/Mood Engine asks for
// (BAR CHORD DENS VELB REG), then let the model sample the notes. A grammar mask keeps
// the output well-formed (POS → PITCH → VEL → DUR), a range mask keeps notes playable
// for the instrument, and a scale bias keeps notes in key (softer for "horror", which
// allows more chromatic notes).

import { INSTRUMENTS } from './instruments.js';
import { chordPitchClasses, clamp, lerp, makeRng, scalePitchClasses } from './theory.js';
import { densBucket, regBucket, tempoBucket, velBucket } from './tokenizer.js';

export function barTargets(name, plan, controls, b) {
  const inst = INSTRUMENTS[name];
  const e = lerp(0.6, plan.energy[b], controls.energyFollow ?? 0.8);
  let n = inst.maxNotesPerBar * controls.density * (0.2 + 0.8 * e);
  if (plan.preDrop[b]) n *= 0.4;
  const vel = 127 * (0.22 + 0.62 * controls.velocity) * (0.62 + 0.5 * e);
  const meanPitch = name === 'drums' ? 42 : inst.center + 12 * (controls.register || 0);
  return { n: Math.round(n), vel, meanPitch };
}

function sampleFrom(logits, allowed, temperature, topK, rng) {
  // allowed: array of [id, bias]
  const cand = allowed.map(([id, bias]) => [id, logits[id] / temperature + bias]);
  cand.sort((a, b) => b[1] - a[1]);
  const top = cand.slice(0, Math.max(1, topK));
  const max = top[0][1];
  const ps = top.map(([, l]) => Math.exp(l - max));
  return rng.weighted(top.map(([id]) => id), ps);
}

export function generateTrackML(model, tok, name, plan, settings, controls, seed, opts = {}) {
  const rng = makeRng(seed);
  const temperature = opts.temperature ?? 1.0;
  const topK = opts.topK ?? 16;
  const inst = INSTRUMENTS[name];
  const isDrums = name === 'drums';
  const shift = 12 * (controls.register || 0);
  const lo = clamp(inst.range[0] + Math.min(0, shift), 21, 108);
  const hi = clamp(inst.range[1] + Math.max(0, shift), 21, 108);
  const scale = new Set(scalePitchClasses(plan.key, plan.scale));
  const penalty = 4.5 * (1 - settings.chromaticism * 0.8);

  const header = [tok.BOS, tok.id(`INST_${name}`), tok.id(`TEMPO_${tempoBucket(plan.tempo)}`)];
  const history = [];
  model.reset();
  let logits = null;
  const feed = (id) => {
    if (model.t >= model.T) {
      // context full: keep header + most recent bars (starting at a BAR token)
      const keep = model.T >> 1;
      let start = history.length - keep;
      while (start < history.length && history[start] !== tok.BAR) start++;
      const recent = history.slice(start);
      model.reset();
      for (const h of header) logits = model.step(h);
      for (const h of recent) logits = model.step(h);
      history.length = 0;
      history.push(...recent);
    }
    logits = model.step(id);
    history.push(id);
  };
  for (const h of header) logits = model.step(h);

  const notes = [];
  const R = tok.ranges;
  const rangeIds = (k, a = 0, b = Infinity) => {
    const out = [];
    for (let id = R[k][0]; id < R[k][1]; id++) {
      const i = id - R[k][0];
      if (i >= a && i <= b) out.push([id, 0]);
    }
    return out;
  };
  const velIds = rangeIds('VEL');
  const durIds = rangeIds('DUR');

  for (let b = 0; b < plan.bars; b++) {
    const tgt = barTargets(name, plan, controls, b);
    const chord = plan.chords[b];
    feed(tok.BAR);
    feed(tok.chordToken(chord));
    feed(tok.id(`DENS_${densBucket(tgt.n)}`));
    feed(tok.id(`VELB_${velBucket(tgt.vel)}`));
    feed(tok.id(`REG_${regBucket(tgt.meanPitch)}`));
    if (tgt.n <= 0) continue; // empty bar requested

    const chordPcs = new Set(chordPitchClasses(chord));
    const maxNotes = Math.max(4, Math.round(tgt.n * 1.6) + 2);
    let pos = -1;
    let state = 'barStart';
    let count = 0;
    let pitch = 0;
    let vel = 0;
    const usedAtPos = new Set();
    const pitchIds = () => {
      const out = [];
      const pLo = isDrums ? 35 : lo;
      const pHi = isDrums ? 81 : hi;
      for (let p = pLo; p <= pHi; p++) {
        if (usedAtPos.has(p)) continue;
        let bias = 0;
        if (!isDrums && !scale.has(p % 12) && !chordPcs.has(p % 12)) bias = -penalty;
        out.push([R.PITCH[0] + p, bias]);
      }
      return out;
    };
    for (let guard = 0; guard < 400; guard++) {
      let allowed;
      if (state === 'barStart' || state === 'afterDur') {
        allowed = [];
        if (count < maxNotes) {
          for (let p = pos + 1; p < 16; p++) allowed.push([R.POS[0] + p, 0]);
          if (state === 'afterDur' && usedAtPos.size < (isDrums ? 4 : 6)) allowed.push(...pitchIds());
        }
        allowed.push([tok.BAR, count === 0 && tgt.n > 0 ? -3 : 0], [tok.EOS, -2]);
      } else if (state === 'afterPos') allowed = pitchIds();
      else if (state === 'afterPitch') allowed = velIds;
      else allowed = durIds;

      if (!allowed.length) break;
      const id = sampleFrom(logits, allowed, temperature, topK, rng);
      if (id === tok.BAR || id === tok.EOS) break; // bar finished (BAR is fed at next bar start)
      feed(id);
      const k = tok.kind(id);
      if (k === 'POS') {
        pos = id - R.POS[0];
        usedAtPos.clear();
        state = 'afterPos';
      } else if (k === 'PITCH') {
        pitch = id - R.PITCH[0];
        usedAtPos.add(pitch);
        state = 'afterPitch';
      } else if (k === 'VEL') {
        vel = (id - R.VEL[0]) * 16 + 8;
        state = 'afterVel';
      } else if (k === 'DUR') {
        const dur = id - R.DUR[0] + 1;
        notes.push({ pitch, start: b * 16 + pos, dur: isDrums ? 1 : dur, vel: clamp(vel, 10, 127) });
        count++;
        state = 'afterDur';
      }
    }
  }
  return notes;
}
