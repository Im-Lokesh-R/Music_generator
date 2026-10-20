// Mood Engine: words → mood blend → valence/arousal → musical parameters.
//
// 1. Each word in the prompt is fuzzy-matched (typo tolerant: "horor", "loft" → lo-fi)
//    against a lexicon that maps words to weighted moods and modifiers.
// 2. The mood weights are normalised into a blend (e.g. 70% horror + 30% sci-fi).
// 3. Numeric parameters (tempo, density, reverb...) are interpolated across the
//    blend; categorical ones (scale, drum style, progression) are drawn from the
//    dominant moods. The result also yields a point in valence/arousal space.

import { INSTRUMENT_ORDER, defaultControls } from './instruments.js';
import { clamp, makeRng } from './theory.js';

// i = instrument preset: [level(0=off), density, velocity, register, brightness, reverb]
const I = (level, density, velocity, register = 0, brightness = 0.6, reverb = 0.3) => ({
  level, density, velocity, register, brightness, reverb,
});

export const MOODS = {
  horror: {
    label: 'Horror', emoji: '👻', valence: -0.85, arousal: 0.45,
    scales: [['harmonicMinor', 2], ['phrygian', 2], ['locrian', 1]],
    keys: [1, 2, 3, 6],
    tempo: [52, 72],
    progressions: [
      [[0, 'min'], [1, 'maj'], [0, 'min'], [6, 'dim']],
      [[0, 'min'], [8, 'maj'], [1, 'maj'], [0, 'cluster']],
      [[0, 'min'], [0, 'min'], [6, 'dim7'], [7, 'aug']],
    ],
    harmonicRhythm: 2, drumStyle: 'horror', swing: 0, chromaticism: 0.55,
    energyShape: 'build',
    lead: ['violin', 'synth', 'flute', 'piano'],
    melody: { step: 0.55, rest: 0.45, longNotes: 0.7 },
    fx: { reverb: 0.85, lofi: 0.0, brightness: 0.35, delay: 0.35 },
    instruments: {
      piano: I(0.8, 0.25, 0.45, -1, 0.35, 0.8), guitar: I(0, 0.2, 0.4), bass: I(0.7, 0.2, 0.55, -1, 0.3),
      drums: I(0.6, 0.15, 0.6, 0, 0.4, 0.7), violin: I(0.9, 0.4, 0.5, 0, 0.5, 0.85),
      strings: I(0.9, 0.5, 0.45, 0, 0.35, 0.9), flute: I(0, 0.2, 0.3), synth: I(0.5, 0.2, 0.35, -1, 0.3, 0.9),
    },
  },
  scifi: {
    label: 'Sci-Fi', emoji: '🚀', valence: 0.05, arousal: 0.45,
    scales: [['lydian', 3], ['wholeTone', 1], ['dorian', 1]],
    keys: [2, 4, 9, 11],
    tempo: [92, 118],
    progressions: [
      [[0, 'maj'], [2, 'maj'], [0, 'maj'], [7, 'sus2']],
      [[0, 'maj9'], [2, 'maj'], [11, 'min7'], [7, 'sus4']],
      [[0, 'sus2'], [4, 'aug'], [2, 'maj'], [9, 'min']],
    ],
    harmonicRhythm: 2, drumStyle: 'scifi', swing: 0, chromaticism: 0.2,
    energyShape: 'buildDrop',
    lead: ['synth', 'violin', 'flute', 'piano'],
    melody: { step: 0.5, rest: 0.25, longNotes: 0.4 },
    fx: { reverb: 0.7, lofi: 0.0, brightness: 0.75, delay: 0.55 },
    instruments: {
      piano: I(0.5, 0.3, 0.5, 0, 0.7, 0.6), guitar: I(0, 0.3, 0.5), bass: I(0.8, 0.55, 0.65, 0, 0.5),
      drums: I(0.8, 0.55, 0.7, 0, 0.7, 0.4), violin: I(0, 0.3, 0.5, 0, 0.6), strings: I(0.7, 0.4, 0.5, 0, 0.6, 0.8),
      flute: I(0, 0.3, 0.4), synth: I(1, 0.75, 0.6, 0, 0.8, 0.6),
    },
  },
  lofi: {
    label: 'Lo-Fi', emoji: '🌧️', valence: 0.2, arousal: -0.45,
    scales: [['major', 2], ['dorian', 1]],
    keys: [0, 2, 5, 7, 9],
    tempo: [70, 88],
    progressions: [
      [[2, 'min7'], [7, 'dom7'], [0, 'maj7'], [9, 'min7']],
      [[5, 'maj7'], [4, 'min7'], [2, 'min7'], [0, 'maj7']],
      [[0, 'maj7'], [9, 'min9'], [2, 'min7'], [7, 'dom7']],
    ],
    harmonicRhythm: 1, drumStyle: 'lofi', swing: 0.22, chromaticism: 0.1,
    energyShape: 'steady',
    lead: ['piano', 'flute', 'guitar', 'synth'],
    melody: { step: 0.65, rest: 0.4, longNotes: 0.3 },
    fx: { reverb: 0.45, lofi: 0.8, brightness: 0.35, delay: 0.2 },
    instruments: {
      piano: I(1, 0.45, 0.45, 0, 0.4, 0.4), guitar: I(0.6, 0.35, 0.45, 0, 0.4, 0.4), bass: I(0.8, 0.4, 0.55, 0, 0.35),
      drums: I(0.9, 0.5, 0.55, 0, 0.35, 0.2), violin: I(0, 0.3, 0.4), strings: I(0.3, 0.3, 0.35, 0, 0.3, 0.5),
      flute: I(0.4, 0.3, 0.4, 0, 0.4, 0.5), synth: I(0, 0.3, 0.4),
    },
  },
  soft: {
    label: 'Soft', emoji: '🕊️', valence: 0.55, arousal: -0.7,
    scales: [['majorPentatonic', 2], ['major', 2]],
    keys: [0, 5, 7, 2],
    tempo: [60, 78],
    progressions: [
      [[0, 'add9'], [7, 'maj'], [9, 'min'], [5, 'maj']],
      [[0, 'maj'], [5, 'maj7'], [9, 'min7'], [7, 'sus4']],
      [[5, 'maj'], [0, 'maj'], [7, 'maj'], [9, 'min']],
    ],
    harmonicRhythm: 2, drumStyle: 'none', swing: 0, chromaticism: 0.02,
    energyShape: 'wave',
    lead: ['flute', 'piano', 'violin', 'guitar'],
    melody: { step: 0.75, rest: 0.35, longNotes: 0.6 },
    fx: { reverb: 0.6, lofi: 0.0, brightness: 0.45, delay: 0.15 },
    instruments: {
      piano: I(1, 0.35, 0.35, 0, 0.45, 0.6), guitar: I(0.4, 0.3, 0.35, 0, 0.45), bass: I(0, 0.2, 0.3),
      drums: I(0, 0.1, 0.3), violin: I(0, 0.3, 0.35), strings: I(0.7, 0.3, 0.3, 0, 0.4, 0.7),
      flute: I(0.7, 0.3, 0.35, 0, 0.5, 0.6), synth: I(0, 0.2, 0.3),
    },
  },
  epic: {
    label: 'Epic', emoji: '⚔️', valence: 0.2, arousal: 0.9,
    scales: [['minor', 3], ['harmonicMinor', 1], ['dorian', 1]],
    keys: [2, 4, 9, 0],
    tempo: [112, 138],
    progressions: [
      [[0, 'min'], [8, 'maj'], [3, 'maj'], [10, 'maj']],
      [[0, 'min'], [10, 'maj'], [8, 'maj'], [7, 'maj']],
      [[0, 'power'], [8, 'power'], [10, 'power'], [5, 'min']],
    ],
    harmonicRhythm: 1, drumStyle: 'epic', swing: 0, chromaticism: 0.08,
    energyShape: 'buildDrop',
    lead: ['violin', 'synth', 'flute', 'piano'],
    melody: { step: 0.55, rest: 0.15, longNotes: 0.5 },
    fx: { reverb: 0.75, lofi: 0, brightness: 0.7, delay: 0.1 },
    instruments: {
      piano: I(0.7, 0.55, 0.7, 0, 0.6, 0.6), guitar: I(0, 0.5, 0.7), bass: I(0.9, 0.6, 0.8, 0, 0.5),
      drums: I(1, 0.75, 0.85, 0, 0.6, 0.6), violin: I(1, 0.55, 0.75, 0, 0.7, 0.6),
      strings: I(1, 0.6, 0.75, 0, 0.6, 0.8), flute: I(0, 0.4, 0.6), synth: I(0.3, 0.4, 0.5, -1, 0.5, 0.7),
    },
  },
  happy: {
    label: 'Happy', emoji: '☀️', valence: 0.9, arousal: 0.55,
    scales: [['major', 3], ['mixolydian', 1], ['majorPentatonic', 1]],
    keys: [0, 7, 2, 9, 4],
    tempo: [108, 128],
    progressions: [
      [[0, 'maj'], [7, 'maj'], [9, 'min'], [5, 'maj']],
      [[0, 'maj'], [5, 'maj'], [7, 'maj'], [5, 'maj']],
      [[0, 'maj'], [9, 'min'], [5, 'maj'], [7, 'maj']],
    ],
    harmonicRhythm: 1, drumStyle: 'pop', swing: 0.05, chromaticism: 0.03,
    energyShape: 'buildDrop',
    lead: ['flute', 'synth', 'piano', 'violin'],
    melody: { step: 0.6, rest: 0.2, longNotes: 0.2 },
    fx: { reverb: 0.35, lofi: 0, brightness: 0.8, delay: 0.15 },
    instruments: {
      piano: I(0.8, 0.55, 0.65, 0, 0.7, 0.3), guitar: I(0.9, 0.6, 0.65, 0, 0.7, 0.3), bass: I(0.9, 0.55, 0.7, 0, 0.55),
      drums: I(0.9, 0.65, 0.7, 0, 0.7, 0.2), violin: I(0, 0.4, 0.6), strings: I(0.3, 0.3, 0.5),
      flute: I(0.8, 0.5, 0.6, 0, 0.7, 0.3), synth: I(0, 0.4, 0.5),
    },
  },
  sad: {
    label: 'Sad', emoji: '🥀', valence: -0.7, arousal: -0.55,
    scales: [['minor', 3], ['dorian', 1], ['minorPentatonic', 1]],
    keys: [9, 4, 2, 11],
    tempo: [58, 76],
    progressions: [
      [[0, 'min'], [8, 'maj'], [3, 'maj'], [10, 'maj']],
      [[0, 'min7'], [5, 'min7'], [10, 'maj'], [3, 'maj7']],
      [[0, 'min'], [5, 'min'], [7, 'min'], [0, 'min']],
    ],
    harmonicRhythm: 2, drumStyle: 'ballad', swing: 0, chromaticism: 0.05,
    energyShape: 'wave',
    lead: ['violin', 'piano', 'flute', 'guitar'],
    melody: { step: 0.75, rest: 0.35, longNotes: 0.6 },
    fx: { reverb: 0.65, lofi: 0.1, brightness: 0.4, delay: 0.2 },
    instruments: {
      piano: I(1, 0.35, 0.45, 0, 0.45, 0.6), guitar: I(0.3, 0.3, 0.4), bass: I(0.5, 0.25, 0.45, 0, 0.35),
      drums: I(0.3, 0.2, 0.35, 0, 0.35, 0.4), violin: I(0.9, 0.35, 0.5, 0, 0.5, 0.7),
      strings: I(0.8, 0.35, 0.4, 0, 0.4, 0.8), flute: I(0, 0.3, 0.4), synth: I(0, 0.2, 0.3),
    },
  },
  romantic: {
    label: 'Romantic', emoji: '💗', valence: 0.7, arousal: -0.15,
    scales: [['major', 3], ['lydian', 1]],
    keys: [5, 3, 8, 0],
    tempo: [68, 88],
    progressions: [
      [[0, 'maj7'], [4, 'min7'], [9, 'min7'], [5, 'maj7']],
      [[0, 'maj'], [9, 'min'], [2, 'min7'], [7, 'dom7']],
      [[5, 'maj7'], [7, 'maj'], [4, 'min7'], [9, 'min']],
    ],
    harmonicRhythm: 1, drumStyle: 'ballad', swing: 0.08, chromaticism: 0.06,
    energyShape: 'wave',
    lead: ['violin', 'flute', 'piano', 'guitar'],
    melody: { step: 0.7, rest: 0.25, longNotes: 0.5 },
    fx: { reverb: 0.6, lofi: 0, brightness: 0.55, delay: 0.15 },
    instruments: {
      piano: I(1, 0.45, 0.5, 0, 0.55, 0.5), guitar: I(0.5, 0.4, 0.45), bass: I(0.6, 0.3, 0.5, 0, 0.4),
      drums: I(0.4, 0.3, 0.4, 0, 0.45, 0.3), violin: I(0.9, 0.4, 0.55, 0, 0.55, 0.6),
      strings: I(0.6, 0.35, 0.45, 0, 0.5, 0.7), flute: I(0.3, 0.3, 0.4), synth: I(0, 0.2, 0.3),
    },
  },
  mysterious: {
    label: 'Mysterious', emoji: '🔮', valence: -0.25, arousal: -0.1,
    scales: [['dorian', 2], ['phrygian', 1], ['harmonicMinor', 1], ['wholeTone', 1]],
    keys: [2, 4, 9, 11],
    tempo: [72, 96],
    progressions: [
      [[0, 'min'], [2, 'maj'], [0, 'min'], [10, 'maj']],
      [[0, 'min7'], [1, 'maj7'], [0, 'min7'], [8, 'maj7']],
      [[0, 'sus2'], [3, 'aug'], [5, 'min'], [0, 'min']],
    ],
    harmonicRhythm: 2, drumStyle: 'horror', swing: 0.05, chromaticism: 0.3,
    energyShape: 'build',
    lead: ['flute', 'synth', 'violin', 'piano'],
    melody: { step: 0.6, rest: 0.4, longNotes: 0.5 },
    fx: { reverb: 0.75, lofi: 0, brightness: 0.45, delay: 0.45 },
    instruments: {
      piano: I(0.8, 0.35, 0.45, 0, 0.45, 0.7), guitar: I(0, 0.3, 0.4), bass: I(0.6, 0.3, 0.5, 0, 0.35),
      drums: I(0.4, 0.25, 0.45, 0, 0.45, 0.6), violin: I(0, 0.3, 0.45), strings: I(0.8, 0.35, 0.4, 0, 0.4, 0.8),
      flute: I(0.8, 0.35, 0.45, 0, 0.5, 0.7), synth: I(0.5, 0.3, 0.4, 0, 0.4, 0.8),
    },
  },
  energetic: {
    label: 'Energetic', emoji: '⚡', valence: 0.5, arousal: 1.0,
    scales: [['minor', 2], ['dorian', 1], ['mixolydian', 1]],
    keys: [5, 7, 9, 0],
    tempo: [124, 140],
    progressions: [
      [[0, 'min'], [8, 'maj'], [3, 'maj'], [10, 'maj']],
      [[0, 'min'], [3, 'maj'], [10, 'maj'], [5, 'min']],
      [[0, 'min7'], [10, 'maj'], [8, 'maj7'], [7, 'min']],
    ],
    harmonicRhythm: 1, drumStyle: 'edm', swing: 0, chromaticism: 0.05,
    energyShape: 'buildDrop',
    lead: ['synth', 'guitar', 'violin', 'piano'],
    melody: { step: 0.45, rest: 0.15, longNotes: 0.1 },
    fx: { reverb: 0.35, lofi: 0, brightness: 0.9, delay: 0.3 },
    instruments: {
      piano: I(0.5, 0.6, 0.7, 0, 0.75, 0.3), guitar: I(0.6, 0.7, 0.8, 0, 0.8, 0.2), bass: I(1, 0.8, 0.85, 0, 0.6),
      drums: I(1, 0.85, 0.9, 0, 0.8, 0.15), violin: I(0, 0.5, 0.7), strings: I(0.3, 0.4, 0.6, 0, 0.6, 0.5),
      flute: I(0, 0.4, 0.6), synth: I(1, 0.85, 0.75, 0, 0.85, 0.4),
    },
  },
  ambient: {
    label: 'Ambient', emoji: '🌌', valence: 0.25, arousal: -0.85,
    scales: [['lydian', 2], ['majorPentatonic', 2], ['dorian', 1]],
    keys: [2, 4, 7, 9],
    tempo: [56, 72],
    progressions: [
      [[0, 'maj9'], [7, 'sus2'], [9, 'min9'], [5, 'maj7']],
      [[0, 'sus2'], [5, 'sus2'], [0, 'sus2'], [7, 'sus4']],
      [[0, 'add9'], [4, 'min7'], [5, 'maj7'], [0, 'add9']],
    ],
    harmonicRhythm: 2, drumStyle: 'none', swing: 0, chromaticism: 0.02,
    energyShape: 'fadeInOut',
    lead: ['flute', 'synth', 'piano', 'violin'],
    melody: { step: 0.7, rest: 0.55, longNotes: 0.8 },
    fx: { reverb: 0.95, lofi: 0.1, brightness: 0.4, delay: 0.5 },
    instruments: {
      piano: I(0.7, 0.2, 0.35, 0, 0.4, 0.9), guitar: I(0, 0.2, 0.3), bass: I(0.3, 0.15, 0.3, -1, 0.3),
      drums: I(0, 0.1, 0.2), violin: I(0, 0.2, 0.3), strings: I(1, 0.3, 0.35, 0, 0.35, 0.95),
      flute: I(0.5, 0.2, 0.3, 0, 0.4, 0.9), synth: I(0.8, 0.25, 0.35, 0, 0.4, 0.95),
    },
  },
  jazz: {
    label: 'Jazz', emoji: '🎷', valence: 0.4, arousal: 0.1,
    scales: [['dorian', 2], ['mixolydian', 1], ['major', 1]],
    keys: [5, 10, 3, 0],
    tempo: [96, 124],
    progressions: [
      [[2, 'min7'], [7, 'dom7'], [0, 'maj7'], [0, 'maj7']],
      [[0, 'maj7'], [9, 'dom7'], [2, 'min7'], [7, 'dom7']],
      [[4, 'hdim7'], [9, 'dom7'], [2, 'min7'], [7, 'dom7']],
    ],
    harmonicRhythm: 1, drumStyle: 'jazz', swing: 0.33, chromaticism: 0.25,
    energyShape: 'wave',
    lead: ['flute', 'piano', 'guitar', 'violin'],
    melody: { step: 0.55, rest: 0.25, longNotes: 0.2 },
    fx: { reverb: 0.4, lofi: 0.15, brightness: 0.55, delay: 0.05 },
    instruments: {
      piano: I(1, 0.5, 0.55, 0, 0.55, 0.35), guitar: I(0.4, 0.4, 0.45, 0, 0.5, 0.3), bass: I(1, 0.6, 0.6, 0, 0.45, 0.2),
      drums: I(0.8, 0.5, 0.45, 0, 0.5, 0.25), violin: I(0, 0.4, 0.5), strings: I(0, 0.3, 0.4),
      flute: I(0.7, 0.45, 0.5, 0, 0.55, 0.35), synth: I(0, 0.3, 0.4),
    },
  },
};

export const MOOD_ORDER = Object.keys(MOODS);

// ---------------- Lexicon ----------------
// word → { moods: {mood: weight}, mod: {...modifiers} }
const L = (moods, mod = {}) => ({ moods, mod });
const LEXICON = {
  // horror family
  horror: L({ horror: 1 }), scary: L({ horror: 1 }), creepy: L({ horror: 0.9, mysterious: 0.3 }),
  ghost: L({ horror: 0.8, mysterious: 0.4 }), haunted: L({ horror: 1 }), evil: L({ horror: 0.9, epic: 0.2 }),
  fear: L({ horror: 1 }), terror: L({ horror: 1 }, { energy: 0.2 }), nightmare: L({ horror: 1 }),
  zombie: L({ horror: 0.9 }), eerie: L({ horror: 0.7, mysterious: 0.5 }), sinister: L({ horror: 0.8 }),
  demon: L({ horror: 1 }), blood: L({ horror: 0.8 }), dread: L({ horror: 0.9 }), thriller: L({ horror: 0.6, mysterious: 0.5 }),
  suspense: L({ horror: 0.5, mysterious: 0.7 }, { shape: 'build' }), tense: L({ horror: 0.5, mysterious: 0.4 }),
  // sci-fi
  scifi: L({ scifi: 1 }), 'sci-fi': L({ scifi: 1 }), space: L({ scifi: 0.8, ambient: 0.4 }), alien: L({ scifi: 0.8, mysterious: 0.4 }),
  robot: L({ scifi: 0.9 }), future: L({ scifi: 0.8 }), futuristic: L({ scifi: 1 }), cyber: L({ scifi: 0.8, energetic: 0.4 }),
  cyberpunk: L({ scifi: 0.7, energetic: 0.5 }), galaxy: L({ scifi: 0.6, ambient: 0.5 }), spaceship: L({ scifi: 1 }),
  neon: L({ scifi: 0.6, energetic: 0.3 }), synthwave: L({ scifi: 0.6, energetic: 0.4 }), cosmic: L({ scifi: 0.6, ambient: 0.6 }),
  // lofi
  lofi: L({ lofi: 1 }), 'lo-fi': L({ lofi: 1 }), loft: L({ lofi: 1 }), chillhop: L({ lofi: 1 }),
  study: L({ lofi: 0.9, soft: 0.2 }), rain: L({ lofi: 0.6, sad: 0.4 }), rainy: L({ lofi: 0.6, sad: 0.4 }),
  coffee: L({ lofi: 0.8, jazz: 0.3 }), cafe: L({ lofi: 0.6, jazz: 0.5 }), vinyl: L({ lofi: 0.8 }, { lofi: 1 }),
  chill: L({ lofi: 0.7, ambient: 0.3 }), relax: L({ lofi: 0.5, soft: 0.5 }), relaxing: L({ lofi: 0.5, soft: 0.5 }),
  night: L({ lofi: 0.4, mysterious: 0.3, ambient: 0.3 }),
  // soft
  soft: L({ soft: 1 }, { energy: -0.2 }), gentle: L({ soft: 1 }), calm: L({ soft: 0.8, ambient: 0.4 }, { energy: -0.2 }),
  peaceful: L({ soft: 0.8, ambient: 0.4 }), lullaby: L({ soft: 1 }, { tempo: -10 }), sleep: L({ soft: 0.6, ambient: 0.6 }),
  meditation: L({ ambient: 0.9, soft: 0.3 }), tender: L({ soft: 0.7, romantic: 0.4 }), quiet: L({ soft: 0.6 }, { energy: -0.25 }),
  // epic
  epic: L({ epic: 1 }), battle: L({ epic: 1 }, { energy: 0.2 }), war: L({ epic: 0.9 }), heroic: L({ epic: 1 }),
  cinematic: L({ epic: 0.7, mysterious: 0.2 }), trailer: L({ epic: 1 }), adventure: L({ epic: 0.6, happy: 0.4 }),
  powerful: L({ epic: 0.8 }, { energy: 0.2 }), dramatic: L({ epic: 0.7, sad: 0.2 }), orchestral: L({ epic: 0.6 }),
  // happy
  happy: L({ happy: 1 }), joy: L({ happy: 1 }), joyful: L({ happy: 1 }), fun: L({ happy: 0.9 }), cheerful: L({ happy: 1 }),
  summer: L({ happy: 0.8 }), sunny: L({ happy: 0.9 }), party: L({ happy: 0.6, energetic: 0.6 }), pop: L({ happy: 0.8 }),
  bright: L({ happy: 0.6 }, { brightness: 0.25 }), uplifting: L({ happy: 0.8, epic: 0.2 }), playful: L({ happy: 0.9 }),
  // sad
  sad: L({ sad: 1 }), melancholy: L({ sad: 1 }), melancholic: L({ sad: 1 }), lonely: L({ sad: 0.9 }), cry: L({ sad: 1 }),
  heartbreak: L({ sad: 0.9, romantic: 0.2 }), grief: L({ sad: 1 }), depressing: L({ sad: 1 }), emotional: L({ sad: 0.6, romantic: 0.4 }),
  nostalgic: L({ sad: 0.4, lofi: 0.5 }), dark: L({ horror: 0.4, mysterious: 0.4, sad: 0.2 }, { brightness: -0.25 }),
  // romantic
  romantic: L({ romantic: 1 }), love: L({ romantic: 1 }), wedding: L({ romantic: 0.8, happy: 0.3 }), dreamy: L({ romantic: 0.4, ambient: 0.6 }),
  sweet: L({ romantic: 0.7, soft: 0.3 }), warm: L({ romantic: 0.5, lofi: 0.3 }),
  // mysterious
  mysterious: L({ mysterious: 1 }), mystery: L({ mysterious: 1 }), magic: L({ mysterious: 0.7, ambient: 0.3 }),
  fantasy: L({ mysterious: 0.6, epic: 0.4 }), detective: L({ mysterious: 0.8, jazz: 0.3 }), secret: L({ mysterious: 0.9 }),
  ancient: L({ mysterious: 0.8, epic: 0.3 }), forest: L({ mysterious: 0.5, ambient: 0.5 }), underwater: L({ ambient: 0.7, mysterious: 0.4 }),
  // energetic
  energetic: L({ energetic: 1 }), edm: L({ energetic: 1 }), dance: L({ energetic: 0.8, happy: 0.3 }), rave: L({ energetic: 1 }),
  workout: L({ energetic: 1 }), gym: L({ energetic: 1 }), hype: L({ energetic: 1 }), action: L({ energetic: 0.6, epic: 0.6 }),
  techno: L({ energetic: 0.8, scifi: 0.3 }), electronic: L({ energetic: 0.5, scifi: 0.5 }), rock: L({ energetic: 0.7, happy: 0.2 }),
  angry: L({ energetic: 0.6, horror: 0.3, epic: 0.3 }), aggressive: L({ energetic: 0.7, epic: 0.4 }), race: L({ energetic: 0.9 }),
  // ambient
  ambient: L({ ambient: 1 }), atmospheric: L({ ambient: 0.9 }), ethereal: L({ ambient: 0.8, mysterious: 0.2 }), drone: L({ ambient: 0.8, horror: 0.2 }),
  ocean: L({ ambient: 0.8, soft: 0.2 }), floating: L({ ambient: 0.9 }), heaven: L({ ambient: 0.6, soft: 0.4 }),
  // jazz
  jazz: L({ jazz: 1 }), jazzy: L({ jazz: 1 }), swing: L({ jazz: 0.9 }), blues: L({ jazz: 0.7, sad: 0.3 }), bossa: L({ jazz: 0.8 }),
  smooth: L({ jazz: 0.6, lofi: 0.3 }), lounge: L({ jazz: 0.8, lofi: 0.2 }), noir: L({ jazz: 0.6, mysterious: 0.5 }),
  // modifiers only
  slow: L({}, { tempo: -18, energy: -0.1 }), fast: L({}, { tempo: 18, energy: 0.1 }), upbeat: L({ happy: 0.3 }, { tempo: 10 }),
  loud: L({}, { energy: 0.25 }), heavy: L({}, { energy: 0.25, brightness: -0.1 }), intense: L({}, { energy: 0.3 }),
  build: L({}, { shape: 'build' }), rising: L({}, { shape: 'build' }), rise: L({}, { shape: 'build' }), raise: L({}, { shape: 'build' }),
  drop: L({}, { shape: 'buildDrop' }), climax: L({}, { shape: 'buildDrop' }), crescendo: L({}, { shape: 'build' }),
  fade: L({}, { shape: 'fadeInOut' }), steady: L({}, { shape: 'steady' }), waves: L({}, { shape: 'wave' }),
  retro: L({ lofi: 0.4 }, { lofi: 0.5 }), oldschool: L({ lofi: 0.5 }, { lofi: 0.6 }), crispy: L({}, { brightness: 0.2 }),
  muffled: L({}, { brightness: -0.3, lofi: 0.3 }), spacious: L({ ambient: 0.3 }, { reverb: 0.25 }), dry: L({}, { reverb: -0.3 }),
};

// Words that turn instruments on
const INSTRUMENT_WORDS = {
  piano: 'piano', keys: 'piano', guitar: 'guitar', acoustic: 'guitar', bass: 'bass', drums: 'drums', drum: 'drums',
  beat: 'drums', beats: 'drums', percussion: 'drums', violin: 'violin', fiddle: 'violin', strings: 'strings',
  orchestra: 'strings', cello: 'strings', flute: 'flute', synth: 'synth', synthesizer: 'synth', pad: 'synth',
};

const ALL_WORDS = [...Object.keys(LEXICON), ...Object.keys(INSTRUMENT_WORDS)];

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/** Find the lexicon entry for a (possibly misspelled) word. */
export function fuzzyLookup(word) {
  const w = word.toLowerCase();
  if (LEXICON[w] || INSTRUMENT_WORDS[w]) return { key: w, distance: 0 };
  if (w.length < 3) return null;
  // simple plural / -y stripping
  for (const stem of [w.replace(/s$/, ''), w.replace(/ies$/, 'y'), w.replace(/ing$/, '')]) {
    if (stem !== w && (LEXICON[stem] || INSTRUMENT_WORDS[stem])) return { key: stem, distance: 0 };
  }
  const maxDist = w.length <= 4 ? 1 : w.length <= 7 ? 2 : 3;
  let best = null;
  for (const cand of ALL_WORDS) {
    if (Math.abs(cand.length - w.length) > maxDist) continue;
    const dist = editDistance(w, cand);
    if (dist <= maxDist && (!best || dist < best.distance)) best = { key: cand, distance: dist };
  }
  return best;
}

/** Text → mood weights, modifiers, mentioned instruments, valence/arousal. */
export function analyzeText(text) {
  const joined = (text || '').toLowerCase().replace(/\b(sci|lo|hi)[\s_]+fi\b/g, '$1fi');
  const words = joined.match(/[a-z][a-z-]*/g) || [];
  const weights = Object.fromEntries(MOOD_ORDER.map((m) => [m, 0]));
  const mod = { tempo: 0, energy: 0, brightness: 0, reverb: 0, lofi: 0, shape: null };
  const matches = [];
  const instruments = new Set();
  let negate = false;
  for (const raw of words) {
    if (['not', 'no', 'without', 'less'].includes(raw)) {
      negate = true;
      continue;
    }
    const hit = fuzzyLookup(raw);
    if (!hit) {
      negate = false;
      continue;
    }
    if (INSTRUMENT_WORDS[hit.key]) {
      if (!negate) instruments.add(INSTRUMENT_WORDS[hit.key]);
      matches.push({ word: raw, match: hit.key, kind: 'instrument', negated: negate });
      negate = false;
      continue;
    }
    const entry = LEXICON[hit.key];
    const sign = negate ? -0.6 : 1;
    for (const [m, w] of Object.entries(entry.moods)) weights[m] += sign * w;
    for (const [k, v] of Object.entries(entry.mod)) {
      if (k === 'shape') mod.shape = v;
      else mod[k] += sign * v;
    }
    matches.push({ word: raw, match: hit.key, kind: 'mood', negated: negate, moods: entry.moods });
    negate = false;
  }
  for (const m of MOOD_ORDER) weights[m] = Math.max(0, weights[m]);
  let total = Object.values(weights).reduce((s, x) => s + x, 0);
  if (total === 0) {
    weights.lofi = 1; // sensible default
    total = 1;
  }
  for (const m of MOOD_ORDER) weights[m] /= total;
  const valence = MOOD_ORDER.reduce((s, m) => s + weights[m] * MOODS[m].valence, 0);
  const arousal = clamp(MOOD_ORDER.reduce((s, m) => s + weights[m] * MOODS[m].arousal, 0) + mod.energy, -1, 1);
  return { weights, mod, matches, instruments: [...instruments], valence, arousal };
}

/** Mood weights obtained directly from chip selection (for when user clicks moods). */
export function weightsFromChips(selected) {
  const weights = Object.fromEntries(MOOD_ORDER.map((m) => [m, 0]));
  selected.forEach((m) => (weights[m] = 1 / selected.length));
  return weights;
}

function blend(weights, getter) {
  return MOOD_ORDER.reduce((s, m) => s + weights[m] * getter(MOODS[m]), 0);
}

function topMoods(weights) {
  return MOOD_ORDER.filter((m) => weights[m] > 0.001).sort((a, b) => weights[b] - weights[a]);
}

/**
 * Turn an analysis into concrete generation settings. Every value here is shown in
 * the UI and can be overridden by the user before generating.
 */
export function buildSettings(analysis, seed = 1) {
  const rng = makeRng(seed * 7919 + 13);
  const { weights, mod } = analysis;
  const tops = topMoods(weights);
  const primary = tops[0];
  const P = MOODS[primary];
  const pickFromTop = (getter) => {
    const mood = rng.weighted(tops, tops.map((m) => weights[m] ** 2));
    return getter(MOODS[mood]);
  };

  const scalePairs = P.scales;
  const scale = rng.weighted(scalePairs.map((s) => s[0]), scalePairs.map((s) => s[1]));
  const key = rng.pick(P.keys);
  const tempoLo = blend(weights, (m) => m.tempo[0]);
  const tempoHi = blend(weights, (m) => m.tempo[1]);
  const tempo = Math.round(clamp(rng.float(tempoLo, tempoHi) + mod.tempo, 50, 180));
  const progression = rng.pick(P.progressions);
  const drumStyle = pickFromTop((m) => m.drumStyle);

  const fx = {
    reverb: clamp(blend(weights, (m) => m.fx.reverb) + mod.reverb, 0, 1),
    lofi: clamp(blend(weights, (m) => m.fx.lofi) + mod.lofi, 0, 1),
    brightness: clamp(blend(weights, (m) => m.fx.brightness) + mod.brightness, 0, 1),
    delay: clamp(blend(weights, (m) => m.fx.delay), 0, 1),
  };

  const energyBoost = mod.energy;
  const instruments = {};
  for (const name of INSTRUMENT_ORDER) {
    const level = blend(weights, (m) => m.instruments[name].level);
    const c = defaultControls();
    c.enabled = level >= 0.45 || analysis.instruments.includes(name);
    c.volume = clamp(0.35 + 0.55 * Math.max(level, analysis.instruments.includes(name) ? 0.7 : 0), 0, 1);
    c.density = clamp(blend(weights, (m) => m.instruments[name].density) + energyBoost * 0.6, 0.05, 1);
    c.velocity = clamp(blend(weights, (m) => m.instruments[name].velocity) + energyBoost * 0.5, 0.1, 1);
    c.register = Math.round(blend(weights, (m) => m.instruments[name].register));
    c.brightness = clamp(blend(weights, (m) => m.instruments[name].brightness) + mod.brightness, 0, 1);
    c.reverb = clamp(blend(weights, (m) => m.instruments[name].reverb) + mod.reverb, 0, 1);
    instruments[name] = c;
  }
  // Give a gentle stereo spread
  const pans = { piano: -0.15, guitar: 0.35, bass: 0, drums: 0, violin: 0.25, strings: -0.3, flute: 0.4, synth: -0.35 };
  for (const n of INSTRUMENT_ORDER) instruments[n].pan = pans[n];
  // If user explicitly named instruments, make sure at least those are on
  if (analysis.instruments.length) {
    const anyNamedOn = analysis.instruments.some((n) => instruments[n].enabled);
    if (!anyNamedOn) analysis.instruments.forEach((n) => (instruments[n].enabled = true));
  }
  // Never generate silence
  if (!INSTRUMENT_ORDER.some((n) => instruments[n].enabled)) instruments.piano.enabled = true;

  return {
    moodWeights: weights,
    primaryMood: primary,
    valence: analysis.valence,
    arousal: analysis.arousal,
    key,
    scale,
    tempo,
    progression,
    harmonicRhythm: P.harmonicRhythm,
    drumStyle,
    swing: clamp(blend(weights, (m) => m.swing), 0, 0.4),
    chromaticism: clamp(blend(weights, (m) => m.chromaticism), 0, 1),
    energyShape: mod.shape || P.energyShape,
    leadOrder: P.lead,
    melody: {
      step: blend(weights, (m) => m.melody.step),
      rest: blend(weights, (m) => m.melody.rest),
      longNotes: blend(weights, (m) => m.melody.longNotes),
    },
    fx,
    instruments,
  };
}
