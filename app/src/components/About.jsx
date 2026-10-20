import { METRIC_INFO } from '../engine/critic.js';

function LossChart({ history }) {
  if (!history?.length) return null;
  const W = 420;
  const H = 150;
  const P = 30;
  const xs = history.map((h) => h.step);
  const ys = history.flatMap((h) => [h.val_loss, h.train_loss]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys) * 0.95, Math.max(...ys) * 1.05];
  const px = (x) => P + ((x - x0) / Math.max(1, x1 - x0)) * (W - 2 * P);
  const py = (y) => H - P + -((y - y0) / (y1 - y0)) * (H - 2 * P);
  const line = (k) => history.map((h) => `${px(h.step)},${py(h[k])}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="loss-chart">
      <polyline points={line('train_loss')} fill="none" stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="4 3" />
      <polyline points={line('val_loss')} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      {history.map((h) => (
        <circle key={h.step} cx={px(h.step)} cy={py(h.val_loss)} r="3" fill="var(--accent)" />
      ))}
      <text x={P} y={14} className="axis-label">loss {y1.toFixed(2)}</text>
      <text x={P} y={H - 8} className="axis-label">{y0.toFixed(2)} · step {x0}</text>
      <text x={W - P} y={H - 8} textAnchor="end" className="axis-label">step {x1}</text>
      <text x={W - P} y={14} textAnchor="end" className="axis-label">— validation  - - train</text>
    </svg>
  );
}

export default function About({ modelInfo, modelError }) {
  const steps = [
    ['1. Mood Engine', 'Fuzzy-matches your words (typos ok: "loft" → lo-fi) against a 170-word lexicon, blends 12 mood profiles and places the result on the valence/arousal map.'],
    ['2. Conductor', 'Chooses key, scale, tempo, chord progression and song form, and turns the rise/drop curve into per-bar energy. Every instrument follows this one plan → no clashing.'],
    ['3. Composers', 'Each instrument gets a role (lead, counter-melody, harmony, rhythm, bass, pad, arp, drums). Notes come from the Transformer (AI) or the music-theory engine.'],
    ['4. Constrained decoding', 'The Transformer is fed control tokens per bar (chord, density, dynamics, register). Grammar, range and key masks keep its output playable and in tune.'],
    ['5. Critic', 'Several candidates are scored (key consistency, harmonic fit, control accuracy, motif structure, mood match) and the best one is kept.'],
    ['6. Synth & mix', 'Notes are synthesised in the browser (Karplus–Strong guitar, bowed violin, synthesised drum kit…) with reverb, delay, lo-fi tape effects, risers and impacts.'],
  ];
  return (
    <div className="about">
      <section className="card">
        <h2>How MoodComposer works</h2>
        <div className="pipeline">
          {steps.map(([t, d]) => (
            <div key={t} className="pipe-step">
              <h4>{t}</h4>
              <p>{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>The AI model</h2>
        {modelInfo ? (
          <>
            <div className="stats">
              <div><b>{(modelInfo.params / 1e6).toFixed(2)}M</b><span>parameters</span></div>
              <div><b>{modelInfo.config.n_layer}</b><span>layers</span></div>
              <div><b>{modelInfo.config.n_head}</b><span>heads</span></div>
              <div><b>{modelInfo.config.d_model}</b><span>model width</span></div>
              <div><b>{modelInfo.config.block_size}</b><span>context tokens</span></div>
              <div><b>{modelInfo.config.vocab_size}</b><span>vocabulary</span></div>
            </div>
            {modelInfo.training && (
              <p className="muted">
                Trained on {modelInfo.training.files} MIDI files → {modelInfo.training.tracks} instrument tracks. Best validation loss{' '}
                {modelInfo.training.best_val_loss?.toFixed(3)} (perplexity {Math.exp(modelInfo.training.best_val_loss || 0).toFixed(2)}).
                {modelInfo.training.instrument_tracks && (
                  <> Tracks per instrument: {Object.entries(modelInfo.training.instrument_tracks).map(([k, v]) => `${k} ${v}`).join(', ')}.</>
                )}
              </p>
            )}
            <LossChart history={modelInfo.training?.history} />
            <p className="muted small">Browser inference self-test vs. PyTorch: max logit error {modelInfo.selfTestError.toExponential(1)}.</p>
          </>
        ) : (
          <p className="muted">
            No trained model loaded{modelError ? ` (${modelError})` : ''}. Train it on Kaggle with <code>training/moodcomposer_kaggle.ipynb</code> and copy{' '}
            <code>model.json</code> + <code>model.bin</code> into <code>app/public/models/</code>. Until then the Theory engine composes everything.
          </p>
        )}
        <div className="arch">
          <code>BOS INST TEMPO │ BAR CHORD DENS VELB REG │ POS PITCH VEL DUR … │ BAR …</code>
          <p className="muted small">
            Decoder-only Transformer (GPT): token + position embeddings → N × [LayerNorm → causal self-attention → LayerNorm → MLP] → tied output head.
            Control tokens are computed from real music during training, so at generation time the app can steer harmony, density, dynamics and register bar by bar.
          </p>
        </div>
      </section>

      <section className="card">
        <h2>Evaluation metrics</h2>
        <table className="metrics-table">
          <tbody>
            {Object.entries(METRIC_INFO).map(([k, v]) => (
              <tr key={k}>
                <td><b>{k}</b></td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Datasets</h2>
        <ul className="muted">
          <li><b>MAESTRO v3</b> — ~200 h of virtuoso piano performances (piano).</li>
          <li><b>Groove MIDI</b> — 13 h of drummers playing an electronic kit (drums).</li>
          <li><b>Lakh MIDI (clean)</b> — multi-instrument songs: guitar, bass, violin, strings, flute, synth.</li>
        </ul>
      </section>
    </div>
  );
}
