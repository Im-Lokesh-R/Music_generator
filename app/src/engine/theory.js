// Music theory primitives: notes, scales, chords, voice leading, seeded RNG.

export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
};

// Chord qualities as semitone stacks above the root.
export const CHORD_TYPES = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus4: [0, 5, 7],
  sus2: [0, 2, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  min9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  dim7: [0, 3, 6, 9],
  hdim7: [0, 3, 6, 10],
  add9: [0, 4, 7, 14],
  minAdd9: [0, 3, 7, 14],
  power: [0, 7, 12],
  cluster: [0, 1, 6],
};

// Base triad family of each quality — used to map chords onto model tokens.
export const CHORD_FAMILY = {
  maj: 'maj', maj7: 'maj', dom7: 'maj', maj9: 'maj', add9: 'maj', power: 'maj',
  min: 'min', min7: 'min', min9: 'min', minAdd9: 'min',
  dim: 'dim', dim7: 'dim', hdim7: 'dim', cluster: 'dim',
  aug: 'aug',
  sus4: 'sus', sus2: 'sus',
};

export function noteName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function chordName(chord) {
  const suffix = {
    maj: '', min: 'm', dim: '°', aug: '+', sus4: 'sus4', sus2: 'sus2', maj7: 'maj7', min7: 'm7',
    dom7: '7', min9: 'm9', maj9: 'maj9', dim7: '°7', hdim7: 'ø7', add9: 'add9', minAdd9: 'm(add9)',
    power: '5', cluster: '(cluster)',
  }[chord.quality] ?? '';
  return NOTE_NAMES[chord.root] + suffix;
}

export function chordPitchClasses(chord) {
  return CHORD_TYPES[chord.quality].map((i) => (chord.root + i) % 12);
}

export function scalePitchClasses(root, scale) {
  return SCALES[scale].map((i) => (root + i) % 12);
}

/** All MIDI pitches in [lo, hi] whose pitch class is in pcs. */
export function pitchesInRange(pcs, lo, hi) {
  const set = new Set(pcs);
  const out = [];
  for (let p = lo; p <= hi; p++) if (set.has(((p % 12) + 12) % 12)) out.push(p);
  return out;
}

/**
 * Build a voicing of `chord` near `center` with `count` notes,
 * choosing the inversion closest to the previous voicing (smooth voice leading).
 */
export function voiceChord(chord, center, count, prev = null, spread = 12) {
  const pcs = CHORD_TYPES[chord.quality].map((i) => chord.root + i);
  const candidates = [];
  for (let inv = 0; inv < pcs.length; inv++) {
    for (let oct = -2; oct <= 2; oct++) {
      const notes = [];
      for (let k = 0; k < count; k++) {
        const idx = (inv + k) % pcs.length;
        const octUp = Math.floor((inv + k) / pcs.length);
        notes.push(pcs[idx] + 12 * (octUp + oct) + 12 * Math.floor(center / 12) - 12);
      }
      // keep within the spread window
      if (notes[notes.length - 1] - notes[0] > spread + 12) continue;
      candidates.push(notes);
    }
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  let best = candidates[0];
  let bestCost = Infinity;
  for (const c of candidates) {
    let cost = Math.abs(mean(c) - center) * 1.0;
    if (prev && prev.length) {
      // voice leading distance: sum of nearest-note moves
      cost += 0.6 * c.reduce((s, n) => s + Math.min(...prev.map((p) => Math.abs(p - n))), 0) / c.length;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best;
}

/** Diatonic chord on a scale degree (0-based), with optional 7th. */
export function diatonicChord(root, scale, degree, seventh = false) {
  const s = SCALES[scale];
  const n = s.length;
  const at = (i) => s[((i % n) + n) % n] + 12 * Math.floor(i / n);
  const r = at(degree);
  const third = at(degree + 2) - r;
  const fifth = at(degree + 4) - r;
  const sev = at(degree + 6) - r;
  let quality;
  if (third === 4 && fifth === 7) quality = seventh ? (sev === 11 ? 'maj7' : 'dom7') : 'maj';
  else if (third === 3 && fifth === 7) quality = seventh ? 'min7' : 'min';
  else if (third === 3 && fifth === 6) quality = seventh ? (sev === 10 ? 'hdim7' : 'dim7') : 'dim';
  else if (third === 4 && fifth === 8) quality = 'aug';
  else quality = 'sus4';
  return { root: (root + r) % 12, quality };
}

// ---------- Seeded RNG (mulberry32) ----------
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    float: (lo = 0, hi = 1) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    weighted: (items, weights) => {
      const total = weights.reduce((s, w) => s + w, 0);
      let r = next() * total;
      for (let i = 0; i < items.length; i++) {
        r -= weights[i];
        if (r <= 0) return items[i];
      }
      return items[items.length - 1];
    },
    gauss: () => {
      const u = Math.max(1e-9, next());
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const lerp = (a, b, t) => a + (b - a) * t;
