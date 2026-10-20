// Node test harness for the engine: node scripts/test-engine.mjs [modelDir] [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { analyzeText, buildSettings } from '../src/engine/moods.js';
import { ENERGY_PRESETS } from '../src/engine/conductor.js';
import { generateSong } from '../src/engine/pipeline.js';
import { songToMidi } from '../src/engine/exporters.js';
import { GPT } from '../src/engine/gpt.js';
import { Tokenizer } from '../src/engine/tokenizer.js';
import { chordName, NOTE_NAMES } from '../src/engine/theory.js';

const modelDir = process.argv[2] || 'public/models';
const outDir = process.argv[3] || null;
let ml = null;
if (fs.existsSync(path.join(modelDir, 'model.json'))) {
  const meta = JSON.parse(fs.readFileSync(path.join(modelDir, 'model.json'), 'utf8'));
  const raw = fs.readFileSync(path.join(modelDir, 'model.bin'));
  const weights = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const model = new GPT(meta, weights);
  const st = model.selfTest(meta);
  console.log(`model ${meta.config.n_layer}L d${meta.config.d_model}: selftest ok=${st.ok} maxErr=${st.maxErr.toExponential(2)}`);
  if (!st.ok) process.exit(1);
  ml = { model, tok: new Tokenizer(meta.vocab) };
} else console.log('no model found — theory engine only');

const prompts = ['dark horror slow build', 'sci-fi spaceship with a big drop', 'loft rainy study beats', 'soft piano lullaby',
  'epic battle trailer', 'happy summer guitar', 'sad violin', 'jazzy cafe'];
let failures = 0;
for (const p of prompts) {
  const a = analyzeText(p);
  const s = buildSettings(a, 3);
  for (const engine of ml ? ['theory', 'hybrid', 'ai'] : ['theory']) {
    const t0 = Date.now();
    const song = generateSong({ settings: s, energyPoints: ENERGY_PRESETS[s.energyShape], duration: 40, seed: 42, engine, temperature: 1 }, ml);
    const ms = Date.now() - t0;
    const notes = song.tracks.reduce((x, t) => x + t.notes.length, 0);
    const bad = song.tracks.some((t) => t.notes.some((n) => !(n.dur > 0) || !(n.vel > 0) || Number.isNaN(n.start)));
    if (bad || notes === 0) failures++;
    console.log(`[${engine}] "${p}" → ${s.primaryMood} ${NOTE_NAMES[s.key]} ${s.scale} ${s.tempo}bpm bars=${song.plan.bars} ` +
      `tracks=${song.tracks.map((t) => `${t.name}:${t.role}:${t.notes.length}`).join(',')} score=${song.critic.score.toFixed(3)} ${ms}ms` +
      ` chords=${song.plan.chords.slice(0, 4).map(chordName).join(' ')}${bad ? ' INVALID' : ''}`);
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `${p.replace(/\W+/g, '_')}_${engine}.mid`), songToMidi(song));
    }
  }
}
console.log(failures ? `FAILURES: ${failures}` : 'all ok');
process.exit(failures ? 1 : 0);
