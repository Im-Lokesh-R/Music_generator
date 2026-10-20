// Mirror of the Python tokenizer in training/mgtrain.py — bucket functions MUST match.

import { CHORD_FAMILY } from './theory.js';

const DENS_THRESH = [0, 1, 3, 5, 8, 12, 17, 24];

export const tempoBucket = (bpm) => Math.min(7, Math.max(0, Math.floor((bpm - 50) / 20)));
export const densBucket = (n) => {
  let b = 0;
  DENS_THRESH.forEach((t, i) => {
    if (n >= t) b = i;
  });
  return b;
};
export const velBucket = (v) => Math.min(7, Math.max(0, Math.floor(v / 16)));
export const regBucket = (meanPitch) => Math.min(7, Math.max(0, Math.floor((meanPitch - 28) / 10)));

export class Tokenizer {
  constructor(vocab) {
    this.vocab = vocab;
    this.ids = new Map(vocab.map((t, i) => [t, i]));
    const first = (prefix) => vocab.findIndex((t) => t.startsWith(prefix));
    this.PITCH0 = this.id('PITCH_0');
    this.POS0 = this.id('POS_0');
    this.VEL0 = this.id('VEL_0');
    this.DUR1 = this.id('DUR_1');
    this.ranges = {
      POS: [this.POS0, this.POS0 + 16],
      PITCH: [this.PITCH0, this.PITCH0 + 128],
      VEL: [this.VEL0, this.VEL0 + 8],
      DUR: [this.DUR1, this.DUR1 + 32],
    };
    this.BAR = this.id('BAR');
    this.EOS = this.id('EOS');
    this.BOS = this.id('BOS');
    if (first('INST_') < 0) throw new Error('vocab missing INST tokens');
  }

  id(name) {
    const i = this.ids.get(name);
    if (i === undefined) throw new Error(`unknown token ${name}`);
    return i;
  }

  chordToken(chord) {
    if (!chord) return this.id('CHORD_N');
    const fam = CHORD_FAMILY[chord.quality] || 'maj';
    return this.id(`CHORD_${chord.root}_${fam}`);
  }

  kind(id) {
    for (const [k, [a, b]] of Object.entries(this.ranges)) if (id >= a && id < b) return k;
    return this.vocab[id];
  }
}
