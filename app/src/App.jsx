import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import About from './components/About.jsx';
import EnergyEditor from './components/EnergyEditor.jsx';
import InstrumentCard from './components/InstrumentCard.jsx';
import MoodMap from './components/MoodMap.jsx';
import PianoRoll from './components/PianoRoll.jsx';
import Slider from './components/Slider.jsx';
import { generate, loadModel } from './engine/client.js';
import { ENERGY_PRESETS } from './engine/conductor.js';
import { METRIC_INFO } from './engine/critic.js';
import { encodeWav, songToMidi } from './engine/exporters.js';
import { INSTRUMENT_ORDER } from './engine/instruments.js';
import { analyzeText, buildSettings, MOOD_ORDER, MOODS } from './engine/moods.js';
import { ENGINES } from './engine/pipeline.js';
import { mixStems, renderStems } from './engine/synth.js';
import { chordName, NOTE_NAMES, SCALES } from './engine/theory.js';

const EXAMPLES = [
  'dark horror slow build with violin',
  'sci-fi spaceship with a big drop',
  'lofi rainy night study beats',
  'soft piano lullaby',
  'epic battle trailer',
  'happy summer guitar pop',
  'sad lonely violin',
  'jazzy cafe at night',
];
const DRUM_STYLES = ['pop', 'rock', 'lofi', 'edm', 'epic', 'horror', 'scifi', 'jazz', 'ballad'];
const SCALE_LABELS = {
  major: 'Major', minor: 'Minor', harmonicMinor: 'Harmonic minor', dorian: 'Dorian', phrygian: 'Phrygian', lydian: 'Lydian',
  mixolydian: 'Mixolydian', locrian: 'Locrian', wholeTone: 'Whole tone', majorPentatonic: 'Major pentatonic', minorPentatonic: 'Minor pentatonic',
};

const pct = (x) => `${Math.round(x * 100)}%`;
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// composition-relevant subset (changes require regenerating notes)
const compositionKey = (settings, energy, duration, engine) =>
  JSON.stringify({
    k: settings.key, s: settings.scale, t: settings.tempo, d: settings.drumStyle, p: settings.progression, sw: settings.swing,
    i: INSTRUMENT_ORDER.map((n) => {
      const c = settings.instruments[n];
      return [c.enabled, c.register, c.density, c.velocity, c.energyFollow];
    }),
    energy, duration, engine,
  });

export default function App() {
  const [tab, setTab] = useState('compose');
  const [prompt, setPrompt] = useState('lofi rainy night study beats');
  const [seed, setSeed] = useState(7);
  const analysis = useMemo(() => analyzeText(prompt), [prompt]);
  const [settings, setSettings] = useState(() => buildSettings(analyzeText('lofi rainy night study beats'), 7));
  const [energy, setEnergy] = useState(() => [...ENERGY_PRESETS[settings.energyShape]]);
  const [duration, setDuration] = useState(45);
  const [engine, setEngine] = useState('theory');
  const [temperature, setTemperature] = useState(1.0);
  const [candidates, setCandidates] = useState(4);
  const [modelInfo, setModelInfo] = useState(null);
  const [modelError, setModelError] = useState(null);
  const [song, setSong] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [wav, setWav] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState(null);
  const [muted, setMuted] = useState({});
  const [solo, setSolo] = useState(null);
  const audioRef = useRef(null);
  const lastPrompt = useRef(prompt);
  const resume = useRef(null);
  const stemCache = useRef({ song: null, data: null });
  const variation = useRef(1);

  // load the trained Transformer (if present)
  useEffect(() => {
    loadModel('/models')
      .then((info) => {
        setModelInfo(info);
        setEngine('hybrid');
      })
      .catch((e) => setModelError(e.message));
  }, []);

  // words → settings (debounced) — the "auto-select" step
  useEffect(() => {
    if (prompt === lastPrompt.current) return;
    const id = setTimeout(() => {
      lastPrompt.current = prompt;
      const s = buildSettings(analysis, seed);
      setSettings(s);
      setEnergy([...ENERGY_PRESETS[s.energyShape]]);
    }, 350);
    return () => clearTimeout(id);
  }, [prompt, analysis, seed]);

  const mixFor = useCallback(
    (s) => ({
      fx: s.fx,
      instruments: Object.fromEntries(
        INSTRUMENT_ORDER.map((n) => [n, { ...s.instruments[n], muted: !!muted[n] || (solo && solo !== n) }]),
      ),
    }),
    [muted, solo],
  );

  const renderAudio = useCallback(
    async (sng, s, autoplay = false) => {
      setRendering(true);
      try {
        if (stemCache.current.song !== sng) {
          stemCache.current = { song: sng, data: await renderStems(sng, (f) => setProgress(`Synthesising instruments… ${Math.round(f * 100)}%`)) };
        }
        const out = await mixStems(sng, stemCache.current.data, mixFor(s));
        const bytes = encodeWav(out.channels, out.sampleRate);
        setWav(bytes);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
        const a = audioRef.current;
        const wasPlaying = !!a && !a.paused;
        const t = a ? a.currentTime : 0;
        resume.current = autoplay ? { t: 0, autoplay: true } : { t, wasPlaying };
        setAudioUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return url;
        });
      } finally {
        setRendering(false);
      }
    },
    [mixFor],
  );

  useEffect(() => {
    const a = audioRef.current;
    if (!a || !audioUrl) return;
    const r = resume.current;
    resume.current = null;
    if (r) {
      a.currentTime = r.t;
      if (r.wasPlaying || r.autoplay) a.play().catch(() => {});
    }
  }, [audioUrl]);

  const run = async (req, autoplay = true) => {
    setBusy(true);
    setError(null);
    setProgress('Composing…');
    try {
      const result = await generate(req, (p) => setProgress(p.stage));
      result.request = req;
      result.compKey = compositionKey(req.settings, req.energyPoints, req.duration, req.engine);
      setSong(result);
      setProgress('Synthesising audio…');
      await renderAudio(result, settings, autoplay);
      setProgress('');
    } catch (e) {
      setError(e.message);
      setProgress('');
    } finally {
      setBusy(false);
    }
  };

  const onGenerate = (newSeed = seed) =>
    run({ settings, energyPoints: energy, duration, seed: newSeed, engine, temperature, candidates });

  const onVariation = () => {
    const s = seed + 1;
    setSeed(s);
    onGenerate(s);
  };

  const onRegenerateInstrument = (name) => {
    if (!song) return;
    variation.current += 1;
    const base = song.request;
    const s2 = { ...base.settings, instruments: { ...base.settings.instruments, [name]: settings.instruments[name] } };
    run({ ...base, settings: s2, keep: song.tracks, only: name, variation: variation.current }, true);
  };

  // live remix when only mix parameters change
  const mixKey = JSON.stringify([settings.fx, INSTRUMENT_ORDER.map((n) => {
    const c = settings.instruments[n];
    return [c.volume, c.brightness, c.reverb, c.pan];
  }), muted, solo]);
  const firstMix = useRef(true);
  useEffect(() => {
    if (firstMix.current) {
      firstMix.current = false;
      return;
    }
    if (!song || busy) return;
    const id = setTimeout(() => renderAudio(song, settings), 450);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mixKey]);

  const stale = song && song.compKey !== compositionKey(settings, energy, duration, engine);

  const setInst = (name) => (c) => setSettings((s) => ({ ...s, instruments: { ...s.instruments, [name]: c } }));
  const setFx = (k) => (v) => setSettings((s) => ({ ...s, fx: { ...s.fx, [k]: v } }));
  const set = (k) => (v) => setSettings((s) => ({ ...s, [k]: v }));

  const toggleMoodWord = (m) => {
    if (analysis.weights[m] > 0.2) {
      // remove every word that pulled the prompt toward this mood
      const drop = new Set(analysis.matches.filter((x) => x.moods && (x.moods[m] || 0) >= 0.5).map((x) => x.word));
      setPrompt(prompt.split(/\s+/).filter((w) => !drop.has(w.toLowerCase().replace(/[^a-z-]/g, ''))).join(' '));
    } else setPrompt(`${prompt} ${MOODS[m].label.toLowerCase()}`.trim());
  };

  const topMoods = MOOD_ORDER.filter((m) => analysis.weights[m] > 0.02).sort((a, b) => analysis.weights[b] - analysis.weights[a]);
  const trackOf = (n) => song?.tracks.find((t) => t.name === n);
  const fileBase = (prompt.trim() || 'moodcomposer').replace(/[^a-z0-9]+/gi, '_').slice(0, 40);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">♪</span>
          <div>
            <h1>MoodComposer</h1>
            <p>Words → mood → multi-instrument music</p>
          </div>
        </div>
        <nav>
          <button className={tab === 'compose' ? 'active' : ''} onClick={() => setTab('compose')}>Compose</button>
          <button className={tab === 'about' ? 'active' : ''} onClick={() => setTab('about')}>How it works</button>
        </nav>
        <div className={`model-badge ${modelInfo ? 'on' : ''}`} title={modelError || ''}>
          {modelInfo ? `AI model loaded · ${(modelInfo.params / 1e6).toFixed(1)}M params` : 'No AI model · theory engine'}
        </div>
      </header>

      {tab === 'about' ? (
        <About modelInfo={modelInfo} modelError={modelError} />
      ) : (
        <main className="layout">
          {/* ---------------- left: prompt + global controls ---------------- */}
          <section className="col">
            <div className="card">
              <h2>1 · Describe the music</h2>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} placeholder="e.g. dark horror with violin, slow build" />
              <div className="chips">
                {MOOD_ORDER.map((m) => (
                  <button key={m} className={`chip ${analysis.weights[m] > 0.2 ? 'active' : ''}`} onClick={() => toggleMoodWord(m)}>
                    {MOODS[m].emoji} {MOODS[m].label}
                  </button>
                ))}
              </div>
              <div className="examples">
                Try:{' '}
                {EXAMPLES.map((e) => (
                  <a key={e} onClick={() => setPrompt(e)}>{e}</a>
                ))}
              </div>
              <div className="analysis">
                <div className="blend">
                  {topMoods.map((m) => (
                    <div key={m} className="blend-row">
                      <span>{MOODS[m].emoji} {MOODS[m].label}</span>
                      <div className="bar"><div style={{ width: pct(analysis.weights[m]) }} /></div>
                      <span className="num">{pct(analysis.weights[m])}</span>
                    </div>
                  ))}
                  <div className="matches">
                    {analysis.matches.map((x, i) => (
                      <span key={i} className={`match ${x.kind}`}>
                        {x.negated ? 'not ' : ''}
                        {x.word}
                        {x.word !== x.match ? ` → ${x.match}` : ''}
                      </span>
                    ))}
                    {!analysis.matches.length && <span className="muted small">No mood words recognised — defaulting to lo-fi.</span>}
                  </div>
                </div>
                <MoodMap valence={analysis.valence} arousal={analysis.arousal} estimate={song ? { v: song.critic.metrics.estValence, a: song.critic.metrics.estArousal } : null} />
              </div>
            </div>

            <div className="card">
              <h2>2 · Shape: rise &amp; drop</h2>
              <EnergyEditor points={energy} onChange={setEnergy} />
              <div className="grid2">
                <Slider label="Length" value={duration} min={20} max={120} step={5} onChange={setDuration} format={(v) => `${v}s`} />
                <Slider label="Tempo" value={settings.tempo} min={50} max={180} step={1} onChange={set('tempo')} format={(v) => `${v} BPM`} />
              </div>
            </div>

            <div className="card">
              <h2>3 · Harmony &amp; style</h2>
              <div className="grid3">
                <label className="field">Key
                  <select value={settings.key} onChange={(e) => set('key')(+e.target.value)}>
                    {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
                  </select>
                </label>
                <label className="field">Scale
                  <select value={settings.scale} onChange={(e) => set('scale')(e.target.value)}>
                    {Object.keys(SCALES).map((s) => <option key={s} value={s}>{SCALE_LABELS[s]}</option>)}
                  </select>
                </label>
                <label className="field">Drum style
                  <select value={settings.drumStyle} onChange={(e) => set('drumStyle')(e.target.value)}>
                    {DRUM_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              </div>
              <div className="progression">
                Chords:{' '}
                {settings.progression.map(([semi, q], i) => (
                  <span key={i} className="chord">{chordName({ root: (settings.key + semi) % 12, quality: q })}</span>
                ))}
                <span className="muted small"> · swing {pct(settings.swing)}</span>
              </div>
              <div className="grid2">
                <Slider label="Reverb (space)" value={settings.fx.reverb} onChange={setFx('reverb')} />
                <Slider label="Lo-fi (tape & vinyl)" value={settings.fx.lofi} onChange={setFx('lofi')} />
                <Slider label="Echo / delay" value={settings.fx.delay} onChange={setFx('delay')} />
                <Slider label="Swing" value={settings.swing} min={0} max={0.4} onChange={set('swing')} format={pct} />
              </div>
            </div>

            <div className="card">
              <h2>4 · Engine</h2>
              <div className="grid2">
                <label className="field">Composer
                  <select value={engine} onChange={(e) => setEngine(e.target.value)}>
                    {Object.entries(ENGINES).map(([k, v]) => (
                      <option key={k} value={k} disabled={k !== 'theory' && !modelInfo}>{v}{k !== 'theory' && !modelInfo ? ' — needs model' : ''}</option>
                    ))}
                  </select>
                </label>
                <label className="field">Seed
                  <div className="seed">
                    <input type="number" value={seed} onChange={(e) => setSeed(parseInt(e.target.value || '0', 10))} />
                    <button className="mini" onClick={() => setSeed(Math.floor(Math.random() * 99999))}>🎲</button>
                  </div>
                </label>
                <Slider label="AI creativity (temperature)" value={temperature} min={0.6} max={1.4} step={0.05} onChange={setTemperature} format={(v) => v.toFixed(2)} />
                <Slider label="Candidates (best-of-N)" value={candidates} min={1} max={8} step={1} onChange={setCandidates} format={(v) => `${v}`} />
              </div>
            </div>
          </section>

          {/* ---------------- right: output + instruments ---------------- */}
          <section className="col wide">
            <div className="card output">
              <div className="gen-row">
                <button className="generate" disabled={busy} onClick={() => onGenerate()}>
                  {busy ? progress || 'Working…' : song ? (stale ? '⟳ Regenerate with new settings' : '⟳ Generate again') : '✦ Generate music'}
                </button>
                <button className="secondary" disabled={busy} onClick={onVariation}>🎲 New variation</button>
              </div>
              {error && <div className="error">⚠ {error}</div>}
              {song && (
                <div className="summary">
                  <span><b>{MOODS[song.settings.primaryMood].emoji} {MOODS[song.settings.primaryMood].label}</b></span>
                  <span>{NOTE_NAMES[song.plan.key]} {SCALE_LABELS[song.plan.scale]}</span>
                  <span>{song.plan.tempo} BPM</span>
                  <span>{song.plan.bars} bars · {fmtTime(song.plan.seconds)}</span>
                  <span>{song.tracks.length} instruments</span>
                  <span>composed in {Math.round(song.elapsedMs)} ms</span>
                  {rendering && <span className="pulse">rendering audio…</span>}
                </div>
              )}
              <PianoRoll song={song} audioRef={audioRef} muted={Object.fromEntries(INSTRUMENT_ORDER.map((n) => [n, !!muted[n] || (solo && solo !== n)]))} />
              {audioUrl && <audio ref={audioRef} src={audioUrl} controls className="player" />}
              {song && (
                <div className="downloads">
                  <button className="mini" disabled={!wav} onClick={() => download(wav, `${fileBase}.wav`, 'audio/wav')}>⬇ WAV audio</button>
                  <button className="mini" onClick={() => download(songToMidi(song), `${fileBase}.mid`, 'audio/midi')}>⬇ MIDI (open in any DAW)</button>
                  <button className="mini" onClick={() => download(JSON.stringify({ prompt, settings: song.settings, plan: song.plan, critic: song.critic }, null, 2), `${fileBase}.json`, 'application/json')}>⬇ Settings JSON</button>
                </div>
              )}
            </div>

            {song && (
              <div className="card">
                <h2>Critic report <span className="score">{pct(song.critic.score)}</span></h2>
                <div className="metrics">
                  {['scaleConsistency', 'chordToneOnBeats', 'controlAccuracy', 'structure', 'moodMatch'].map((k) => (
                    <div key={k} className="metric" title={METRIC_INFO[k]}>
                      <span>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                      <div className="bar"><div style={{ width: pct(song.critic.metrics[k]) }} /></div>
                      <span className="num">{pct(song.critic.metrics[k])}</span>
                    </div>
                  ))}
                </div>
                <p className="muted small">
                  Pitch-class entropy {song.critic.metrics.pitchClassEntropy.toFixed(2)} bits · silent instrument-bars {pct(song.critic.metrics.emptyBarRate)} ·
                  best of {song.candidates.length} candidate{song.candidates.length > 1 ? 's' : ''} ({song.candidates.map((c) => pct(c.score)).join(', ')}) ·
                  sections: {song.plan.sections.map((s) => s.name).join(' → ')}
                </p>
              </div>
            )}

            <div className="card">
              <h2>5 · Instruments <span className="muted small">— auto-selected from your words; tweak anything</span></h2>
              <div className="inst-grid">
                {INSTRUMENT_ORDER.map((n) => (
                  <InstrumentCard
                    key={n}
                    name={n}
                    controls={settings.instruments[n]}
                    onChange={setInst(n)}
                    track={trackOf(n)}
                    muted={!!muted[n]}
                    solo={solo === n}
                    busy={busy}
                    onMute={() => setMuted((m) => ({ ...m, [n]: !m[n] }))}
                    onSolo={() => setSolo((s) => (s === n ? null : n))}
                    onRegenerate={() => onRegenerateInstrument(n)}
                  />
                ))}
              </div>
            </div>
          </section>
        </main>
      )}
      <footer>MoodComposer · ML college project · Transformer + music-theory hybrid music generator</footer>
    </div>
  );
}
