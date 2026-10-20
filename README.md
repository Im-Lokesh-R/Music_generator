# 🎵 MoodComposer — Mood-Controlled Multi-Instrument Music Generator

Type a few words — *"dark horror slow build with violin"*, *"lofi rainy study beats"*, *"epic battle trailer"* —
and MoodComposer composes, arranges, synthesises and mixes an original multi-instrument piece of music.
Every instrument can then be tuned with its own sliders (pitch range, density, dynamics, tone, reverb, pan, volume),
and the overall **rise & drop** of the song is drawn as a curve.

ML college project · Transformer (GPT) trained on MIDI + music-theory engine · runs fully in the browser.

---

## ✨ Features

| | |
|---|---|
| **Words → music** | 170-word mood lexicon with typo tolerance (`loft` → lo-fi, `horor` → horror), negation (`not sad`), modifiers (`slow`, `dark`, `drop`, `vinyl`…) and instrument words (`violin`, `piano`…). |
| **12 moods** | Horror, Sci-Fi, Lo-Fi, Soft, Epic, Happy, Sad, Romantic, Mysterious, Energetic, Ambient, Jazz — blendable (e.g. 70% horror + 30% sci-fi). |
| **8 instruments** | Piano, Guitar, Bass, Drums, Violin, Strings, Flute, Synth — auto-selected by mood, each with 8 controls. |
| **Rise & drop editor** | Draw the energy curve or pick a preset (steady, build, build→drop, waves, fade). Risers and impacts are added at drops. |
| **AI Transformer** | 6-layer GPT trained on MAESTRO + Groove + Lakh MIDI with per-bar control tokens (chord, density, dynamics, register). Runs in the browser via a custom JS inference engine with KV-cache. |
| **3 engines** | *Theory* (rule-based), *Hybrid* (AI accompaniment + theory melody), *AI* (Transformer for all instruments). |
| **Critic** | Generates best-of-N candidates and scores them (key consistency, harmonic fit, control accuracy, motif structure, mood match). |
| **Audio** | In-browser synthesis: Karplus-Strong guitar, bowed violin with vibrato, synthesised drum kit, reverb, delay, lo-fi tape/vinyl. |
| **Export** | WAV audio, multi-track MIDI (open in FL Studio / Ableton / MuseScore), settings JSON. |
| **Live mixing** | Volume/tone/reverb/pan/mute/solo re-mix instantly; "New part" re-composes one instrument and keeps the rest. |

---

## 🚀 Quick start (the app)

Requirements: **Node.js 18+** (no Python, no GPU needed to run the app).

```bash
cd app
npm install
npm run dev
```

Open **http://localhost:5173**. Type a mood, press **✦ Generate music**.

Without a trained model the app uses the Theory engine. Once `app/public/models/model.json` and `model.bin`
exist, the badge in the top-right turns green and the Hybrid / AI engines unlock.

Production build: `npm run build` → static files in `app/dist/` (host anywhere, e.g. Netlify / GitHub Pages).

---

## 🧠 Training the model on Kaggle (free GPU)

1. Go to <https://www.kaggle.com/code> → **New Notebook** → **File → Import Notebook** → upload
   `training/moodcomposer_kaggle.ipynb`.
2. Right panel → **Session options**: *Accelerator* = **GPU T4 x2** (or P100), *Internet* = **On**
   (needs a phone-verified Kaggle account).
3. **Run All**. The notebook downloads MAESTRO, Groove MIDI and Lakh MIDI (clean), tokenises them,
   trains for ~16k steps (≈ 1 h on a T4) and exports the weights.
4. In the right panel open **Output → /kaggle/working/export/**, download `model.json` and `model.bin`.
5. Copy both files into `app/public/models/` and refresh the app.

Tips: if the Lakh download is slow you can add the Kaggle dataset *"Lakh MIDI Clean"* via **Add Input** —
the notebook automatically uses any `.mid` files found under `/kaggle/input`. Change `CONFIG` in cell 1
for a bigger/smaller model.

Local CPU training (small "starter" model, ~1–2 h): `cd training && python mgtrain.py --local`
(then copy `training/work/export/*` to `app/public/models/`). `python mgtrain.py --smoke` runs a 1-minute self-test.

---

## 🏗️ How it works

```
"dark horror, slow build"  ──►  1. Mood Engine      words → mood blend → valence/arousal → parameters
                                 2. Conductor        key, scale, tempo, chords, song form, per-bar energy
                                 3. Composers        roles (lead / counter / harmony / rhythm / bass / pad / arp / drums)
                                    ├─ Transformer   control tokens + constrained decoding (grammar, range, key masks)
                                    └─ Theory engine motifs, voice leading, groove patterns, fills
                                 4. Critic           best-of-N by quality + mood metrics
                                 5. Synth & mix      stems (chunked offline rendering) → mix → lo-fi → master
                                 ──►  WAV / MIDI / piano roll
```

**Why the Conductor matters:** generating each instrument separately (one model per instrument, layered)
puts instruments in different keys/chords — it sounds bad. Our ablation (see `docs/results.md`) shows chord-tone
agreement drops from **0.96 → 0.49** without the shared plan.

**Token format** (one instrument track):
```
BOS INST_piano TEMPO_3 | BAR CHORD_9_min DENS_4 VELB_4 REG_3 | POS_0 PITCH_57 VEL_4 DUR_8 POS_4 PITCH_64 VEL_3 DUR_4 … | BAR …
```
Control tokens are *measured* from real music during training, so at generation time they become knobs.

---

## 📁 Project structure

```
Music_generator/
├── app/                         React + Vite web app
│   ├── public/models/           ← put model.json + model.bin here
│   ├── scripts/test-engine.mjs  engine tests (node)       npm test
│   ├── scripts/evaluate.mjs     evaluation for the report node scripts/evaluate.mjs > ../docs/results.md
│   └── src/
│       ├── App.jsx, components/ UI (energy editor, instrument cards, piano roll, mood map, about page)
│       └── engine/
│           ├── moods.js         Mood Engine (lexicon, fuzzy matching, 12 mood profiles)
│           ├── conductor.js     shared plan: chords, sections, energy curve
│           ├── procedural.js    music-theory composer for all 8 instruments
│           ├── gpt.js           Transformer inference in JS (KV-cache)
│           ├── tokenizer.js     token vocabulary (mirrors Python)
│           ├── mlGenerator.js   constrained decoding with control tokens
│           ├── pipeline.js      engine selection, best-of-N, swing
│           ├── critic.js        evaluation metrics
│           ├── synth.js         Web Audio synthesis, effects, mixing
│           ├── exporters.js     MIDI + WAV writers
│           └── worker.js        Web Worker (keeps UI responsive)
├── training/
│   ├── mgtrain.py               full training pipeline (data → tokens → GPT → export)
│   ├── moodcomposer_kaggle.ipynb  same, as a Kaggle notebook (python build_notebook.py)
│   └── build_notebook.py
├── docs/
│   ├── REPORT.md                project report
│   └── results.md               evaluation tables
└── PLAN.md                      original project plan
```

---

## 🧪 Testing

```bash
cd app
npm test                                   # generates 8 prompts × all engines, validates notes, MIDI export
node scripts/evaluate.mjs > ../docs/results.md   # full evaluation tables
```

---

## 📚 References

- Huang et al., *Music Transformer* (2018) · Huang & Yang, *Pop Music Transformer / REMI* (2020)
- Ens & Pasquier, *MMM: Multi-Track Music Machine* (2020) · von Rütte et al., *FIGARO* (2023)
- Hung et al., *EMOPIA* (2021) · Russell, *A circumplex model of affect* (1980)
- Hawthorne et al., *MAESTRO* (2019) · Gillick et al., *Groove MIDI* (2019) · Raffel, *Lakh MIDI* (2016)
- Karplus & Strong, *Digital synthesis of plucked-string and drum timbres* (1983)
