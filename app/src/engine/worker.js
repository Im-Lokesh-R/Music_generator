// Web Worker: loads the Transformer and runs note generation off the UI thread.
import { GPT } from './gpt.js';
import { generateSong } from './pipeline.js';
import { Tokenizer } from './tokenizer.js';

let ml = null;

async function loadModel(base) {
  const metaRes = await fetch(`${base}/model.json`, { cache: 'no-cache' });
  if (!metaRes.ok) throw new Error('no model found');
  const meta = await metaRes.json();
  const binRes = await fetch(`${base}/model.bin`, { cache: 'no-cache' });
  if (!binRes.ok) throw new Error('model.bin missing');
  const weights = new Float32Array(await binRes.arrayBuffer());
  const model = new GPT(meta, weights);
  const test = model.selfTest(meta);
  if (!test.ok) throw new Error(`self-test failed (max error ${test.maxErr})`);
  const counts = meta.training?.instrument_tracks;
  const trained = counts ? new Set(Object.keys(counts).filter((k) => counts[k] >= 20)) : null;
  ml = { model, tok: new Tokenizer(meta.vocab), trained };
  const params = weights.length;
  return {
    config: meta.config,
    params,
    trainedInstruments: trained ? [...trained] : null,
    selfTestError: test.maxErr,
    training: meta.training || null,
  };
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    if (type === 'loadModel') {
      const info = await loadModel(payload.base);
      self.postMessage({ id, type: 'result', payload: info });
    } else if (type === 'generate') {
      const t0 = performance.now();
      const song = generateSong(payload, ml, (p) => self.postMessage({ id, type: 'progress', payload: p }));
      song.elapsedMs = performance.now() - t0;
      self.postMessage({ id, type: 'result', payload: song });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', payload: String(err.message || err) });
  }
};
