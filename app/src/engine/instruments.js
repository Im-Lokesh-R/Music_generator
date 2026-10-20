// Instrument catalogue. `program` = General MIDI program for MIDI export,
// `range` = playable MIDI pitch range, `role` drives the procedural generator,
// `maxNotesPerBar` maps the density slider to an expected note count (also used
// to build the DENS control token for the Transformer).

export const INSTRUMENTS = {
  piano: {
    label: 'Piano', icon: '🎹', color: '#7c9cff', program: 0, channel: 0,
    range: [36, 96], center: 64, role: 'harmony', maxNotesPerBar: 18,
  },
  guitar: {
    label: 'Guitar', icon: '🎸', color: '#ffb35c', program: 25, channel: 1,
    range: [40, 84], center: 58, role: 'rhythm', maxNotesPerBar: 18,
  },
  bass: {
    label: 'Bass', icon: '🎚️', color: '#ff6b8b', program: 33, channel: 2,
    range: [28, 55], center: 40, role: 'bass', maxNotesPerBar: 8,
  },
  drums: {
    label: 'Drums', icon: '🥁', color: '#c4c4c4', program: 0, channel: 9,
    range: [35, 81], center: 42, role: 'drums', maxNotesPerBar: 26,
  },
  violin: {
    label: 'Violin', icon: '🎻', color: '#b07cff', program: 40, channel: 3,
    range: [55, 100], center: 76, role: 'lead', maxNotesPerBar: 8,
  },
  strings: {
    label: 'Strings', icon: '🎼', color: '#4fd1c5', program: 48, channel: 4,
    range: [40, 88], center: 62, role: 'pad', maxNotesPerBar: 8,
  },
  flute: {
    label: 'Flute', icon: '🪈', color: '#7ee787', program: 73, channel: 5,
    range: [60, 96], center: 79, role: 'counter', maxNotesPerBar: 7,
  },
  synth: {
    label: 'Synth', icon: '🎛️', color: '#ff7ce5', program: 81, channel: 6,
    range: [48, 96], center: 67, role: 'arp', maxNotesPerBar: 16,
  },
};

export const INSTRUMENT_ORDER = ['piano', 'guitar', 'bass', 'drums', 'violin', 'strings', 'flute', 'synth'];

// General MIDI drum map (subset we use)
export const DRUM = {
  kick: 36, rim: 37, snare: 38, clap: 39, snare2: 40, lowTom: 41, closedHat: 42, midTom: 45,
  pedalHat: 44, openHat: 46, highTom: 48, crash: 49, ride: 51, china: 52, rideBell: 53,
  tambourine: 54, splash: 55, cowbell: 56, crash2: 57, shaker: 70,
};

export const DRUM_NAMES = Object.fromEntries(Object.entries(DRUM).map(([k, v]) => [v, k]));

export function defaultControls() {
  return {
    enabled: true,
    volume: 0.8, // mix gain
    register: 0, // octave shift (-2..+2) — the "frequency" control
    density: 0.5, // how many notes
    velocity: 0.6, // how hard notes are played (dynamics)
    brightness: 0.6, // tone: dark ↔ bright (low-pass cutoff)
    reverb: 0.3, // space
    pan: 0, // -1 left .. +1 right
    energyFollow: 0.8, // how strongly the instrument follows the rise/drop curve
  };
}
