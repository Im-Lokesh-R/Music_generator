// MIDI (SMF type 1) and WAV (16-bit PCM) writers — no dependencies.

import { INSTRUMENTS } from './instruments.js';

const TPQ = 480;
const TICKS_PER_STEP = TPQ / 4;

function vlq(n) {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}

const str = (s) => [...s].map((c) => c.charCodeAt(0) & 0x7f);
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >>> 8) & 255, n & 255];

function chunk(type, data) {
  return [...str(type), ...u32(data.length), ...data];
}

function trackChunk(events) {
  // events: [{tick, bytes}] (unsorted)
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data = [];
  let last = 0;
  for (const e of events) {
    data.push(...vlq(Math.max(0, e.tick - last)), ...e.bytes);
    last = e.tick;
  }
  data.push(0, 0xff, 0x2f, 0);
  return chunk('MTrk', data);
}

export function songToMidi(song) {
  const { plan, tracks } = song;
  const mpqn = Math.round(60000000 / plan.tempo);
  const conductor = [
    { tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(12), ...str('MoodComposer')] },
    { tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (mpqn >> 16) & 255, (mpqn >> 8) & 255, mpqn & 255] },
    { tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] },
  ];
  const chunks = [trackChunk(conductor)];
  for (const t of tracks) {
    const inst = INSTRUMENTS[t.name];
    const ch = inst.channel;
    const name = str(inst.label);
    const ev = [{ tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(name.length), ...name] }];
    if (ch !== 9) ev.push({ tick: 0, order: 1, bytes: [0xc0 | ch, inst.program] });
    for (const n of t.notes) {
      const on = Math.round(n.start * TICKS_PER_STEP);
      const off = Math.max(on + 1, Math.round((n.start + n.dur) * TICKS_PER_STEP));
      ev.push({ tick: on, order: 3, bytes: [0x90 | ch, n.pitch & 127, Math.max(1, Math.min(127, Math.round(n.vel)))] });
      ev.push({ tick: off, order: 2, bytes: [0x80 | ch, n.pitch & 127, 0] });
    }
    chunks.push(trackChunk(ev));
  }
  const header = chunk('MThd', [...u16(1), ...u16(chunks.length), ...u16(TPQ)]);
  return new Uint8Array([...header, ...chunks.flat()]);
}

/** channels: Float32Array[] (stereo), returns Uint8Array WAV file */
export function encodeWav(channels, sampleRate) {
  const n = channels[0].length;
  const nch = channels.length;
  const buf = new ArrayBuffer(44 + n * nch * 2);
  const dv = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  dv.setUint32(4, 36 + n * nch * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, nch, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nch * 2, true);
  dv.setUint16(32, nch * 2, true);
  dv.setUint16(34, 16, true);
  w(36, 'data');
  dv.setUint32(40, n * nch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}
