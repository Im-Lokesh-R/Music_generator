# Mood-Controlled Multi-Instrument Music Generator — Project Plan

**Working title:** *MoodComposer*: a conditional Transformer system that generates
multi-instrument music from mood words (e.g. "horror", "lo-fi", "sci-fi", "soft"),
with per-instrument controls for pitch range, volume, energy rise/drop, and more.

---

## 1. The core idea in one picture

```
 "dark horror, slow build, drop at 60%"   +   [piano] [violin] [drums]   +   sliders
                │                                        │                     │
                ▼                                        │                     │
   ┌──────────────────────────┐                          │                     │
   │ 1. Mood Engine (NLP)      │  text → mood vector      │                     │
   │   words → valence/arousal │  → musical parameters    │                     │
   └────────────┬─────────────┘                          │                     │
                ▼                                        ▼                     ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │ 2. Conductor: picks key, scale, tempo, chord progression, song structure,     │
   │    and an energy curve (rise / drop) shared by ALL instruments                │
   └────────────┬─────────────────────────────────────────────────────────────────┘
                ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │ 3. Instrument models (trained Transformers): piano · drums · guitar · violin   │
   │    · bass · strings — each generates notes conditioned on the shared plan      │
   │    + its own control values (register, density, velocity, energy)            │
   └────────────┬─────────────────────────────────────────────────────────────────┘
                ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │ 4. Post-processing: scale snapping, quantize, humanize, MIDI merge            │
   │ 5. Render & mix: SoundFont synthesis → effects (reverb, lo-fi, filter) →      │
   │    per-track volume/pan → mastering → WAV/MP3 + MIDI                         │
   └────────────┬─────────────────────────────────────────────────────────────────┘
                ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │ 6. Critic: mood classifier + quality metrics score the result; best of N kept │
   └──────────────────────────────────────────────────────────────────────────────┘
```

**Why your "it sounds bad when everything plays together" problem is solved:**
every instrument is generated against the *same* key, tempo, chord progression, and
energy curve (the Conductor). Instruments are no longer generated blindly in isolation.

---

## 2. Key design decision: symbolic (MIDI) vs raw audio

| Approach | Quality | Compute | Controllability | Verdict |
|---|---|---|---|---|
| **Symbolic (MIDI notes) → render with instrument samples** | Clean, real instrument sound | Trains on a free Colab/Kaggle GPU | Excellent — you control every note | ✅ **Use this** |
| Raw audio generation (MusicGen / diffusion) | Can be great, often muddy | Needs big GPUs, days of training | Weak per-instrument control | Optional comparison baseline only |

We generate **notes** with ML, then turn notes into sound with high-quality instrument
samples (SoundFonts). This is exactly your "train on piano notes → generate piano notes" idea.

---

## 3. Datasets (all free)

| Instrument / purpose | Dataset | Notes |
|---|---|---|
| Piano | **MAESTRO v3** | ~200 h of classical piano MIDI |
| Piano + emotion labels | **EMOPIA** | 1,078 clips labeled by valence/arousal quadrant — trains the mood link |
| Drums | **Groove MIDI Dataset (GMD)** | 13 h of real drummer performances |
| Multi-instrument (guitar, violin, bass, strings) | **Lakh MIDI Dataset (LMD-clean / LMD-matched)** | 45k+ songs; extract tracks by General MIDI program number |
| Guitar | **DadaGP** (optional) | Guitar tab dataset, 26k songs |
| Pop structure / chords | **POP909** | Melody + chord annotations |
| Game / film moods | **VGMIDI** | Video game MIDI with sentiment labels (useful for horror / sci-fi) |

Instrument extraction from Lakh uses GM program numbers: piano 0–7, guitar 24–31,
bass 32–39, violin 40, strings 48–51, drums = channel 10.

---

## 4. The ML components (what makes it "advanced")

### 4.1 Tokenization
- Use **MidiTok** with the **REMI+** tokenizer (bar, position, pitch, velocity, duration, tempo, chord tokens).
- Add custom **control tokens** placed at the start of every bar:
  `<MOOD_x> <KEY_x> <CHORD_x> <ENERGY_0..9> <DENSITY_0..9> <REGISTER_low/mid/high> <VEL_0..9>`
- During training these control tokens are **computed automatically from the real data**
  (e.g. density = notes per bar, register = mean pitch, energy = density × velocity).
  At generation time the user/Mood Engine sets them → the model obeys.
  This technique is called **attribute-conditioned generation** (like FIGARO / MuseMorphose).

### 4.2 Instrument models
- Architecture: **decoder-only Transformer** (GPT-style), ~15–40M parameters,
  relative positional encoding (or RoPE), context 1024–2048 tokens.
- Strategy (recommended): **one shared backbone pretrained on all of Lakh**, then
  **fine-tuned per instrument** (piano expert, drum expert, guitar expert, violin expert…).
  Uses LoRA adapters so each instrument adds only a few MB.
  → Matches your idea ("a piano model, a drum model…") while sharing musical knowledge.
- Generation: top-k / nucleus sampling with temperature; **constrained decoding**
  (mask out-of-scale pitches, out-of-range notes for each instrument).

### 4.3 Conductor (harmony + structure)
- Small Transformer or Markov model trained on **POP909 / Lakh chord annotations** to
  generate chord progressions conditioned on mood (minor/diminished for horror,
  major 7ths for lo-fi, suspended/modal for sci-fi).
- Produces song form: Intro → Build → Drop/Climax → Breakdown → Outro,
  plus the per-bar **energy curve** (your "raise and drop").

### 4.4 Mood Engine (words → music parameters)
Two layers:
1. **Rule/preset layer (explainable):** a table mapping mood words → parameter values.
2. **Learned layer (ML):** a sentence-embedding model (`sentence-transformers` or **CLAP**)
   embeds any free text ("eerie abandoned spaceship"), and a small MLP regresses
   **valence & arousal** (trained on EMOPIA/VGMIDI labels + preset words).
   Valence/arousal → parameters via interpolation between presets, so even
   unseen words work.

Example preset table:

| Mood | Key/Scale | Tempo | Instruments favored | Register | Density | Effects |
|---|---|---|---|---|---|---|
| Horror | Minor / diminished, chromatic | 50–70 | Violin tremolo, low piano, sparse drums | Low + very high | Sparse | Heavy reverb, dissonance |
| Sci-fi | Lydian / whole-tone | 90–120 | Synth pad, arpeggio, electronic drums | Mid–high | Medium | Delay, chorus |
| Lo-fi | Major 7 / minor 9 chords | 70–90 | Electric piano, soft drums, bass | Mid | Medium-low | Low-pass, bitcrush, vinyl noise, wow/flutter |
| Soft / calm | Major / pentatonic | 60–80 | Piano, strings | Mid | Low | Gentle reverb |
| Epic | Minor, power chords | 110–140 | Strings, brass, big drums | Full | High | Big reverb |
| Happy | Major | 110–130 | Guitar, piano, pop drums | Mid–high | High | Light |

### 4.5 Per-instrument controls (your "frequency, sound, raise and drop" values)
Each selected instrument gets sliders (auto-filled by the mood, then user-adjustable):

| Control | Meaning | Affects |
|---|---|---|
| **Pitch range / register** ("frequency") | low ↔ high notes | `<REGISTER>` token + pitch mask |
| **Volume** | loudness in the mix | mixer gain |
| **Velocity / dynamics** | soft ↔ hard playing | `<VEL>` token |
| **Density** | few ↔ many notes | `<DENSITY>` token |
| **Energy curve** ("raise & drop") | drawn curve over time | per-bar `<ENERGY>` tokens + automation |
| **Brightness / tone** ("sound") | dark ↔ bright | low-pass filter cutoff |
| **Reverb / space** | dry ↔ hall | effect send |
| **Pan** | left ↔ right | mixer |
| **Creativity** | safe ↔ adventurous | sampling temperature |

### 4.6 Critic / auto-selection (extra-advanced)
- Train a **mood classifier** (CNN/Transformer on MIDI tokens, EMOPIA labels).
- Generate N candidates → keep the one the classifier rates closest to the requested mood
  and that scores best on quality metrics. Optionally CLAP text–audio similarity for reranking.

---

## 5. Audio rendering & mixing
- **FluidSynth** + free SoundFonts (e.g. *FluidR3_GM*, *GeneralUser GS*, *Salamander Piano*)
  to turn MIDI into realistic instrument audio.
- **Spotify `pedalboard`** for effects: reverb, delay, chorus, low-pass, bitcrush (lo-fi),
  compressor, limiter.
- Mixing: per-track gain/pan, sidechain-style ducking on drops, loudness normalization
  to −14 LUFS with `pyloudnorm`.
- Output: **WAV + MP3 + MIDI** (MIDI lets users open the result in any DAW).

---

## 6. Evaluation (needed for the report)
1. **Objective metrics** (MusPy): pitch-class entropy, scale consistency, groove consistency,
   empty-beat rate, polyphony, compared against real data.
2. **Model metrics:** validation loss / perplexity per instrument.
3. **Controllability:** correlation between requested and measured density/register/velocity
   (e.g. ask for density 8 → measure notes per bar).
4. **Mood accuracy:** mood classifier on generated music — does "horror" get classified as
   low-valence/high-arousal?
5. **Fréchet Audio Distance (FAD)** vs. real recordings.
6. **Listening test:** 10–20 people rate samples 1–5 (MOS) and guess the mood.
7. **Ablations:** with vs. without Conductor, with vs. without control tokens,
   rule-only vs. learned Mood Engine.

---

## 7. Application (UI)
- **Gradio** web app (fast to build, looks good in demos). Optional: FastAPI backend + React frontend.
- Screens/controls:
  - Text prompt box ("lo-fi rainy night") + mood chips (Horror, Sci-fi, Lo-fi, Soft, Epic, Happy…)
  - Instrument checkboxes, each expanding to its slider panel (§4.5)
  - Energy-curve editor (presets: steady, slow build, build + drop, wave)
  - Duration, tempo override, key override, random seed
  - Output: audio player, **piano-roll visualization** per track, download WAV/MIDI
  - "Regenerate just this instrument" button (keeps the others)

---

## 8. Tech stack
Python 3.11 · PyTorch · MidiTok · pretty_midi · music21 · MusPy · sentence-transformers / CLAP ·
pyfluidsynth / midi2audio · pedalboard · pyloudnorm · Gradio · (optional) FastAPI ·
Weights & Biases or TensorBoard for training logs · Google Colab / Kaggle (free T4/P100 GPU) for training.

---

## 9. Folder structure
```
Music_generator/
├── data/                 # raw + processed datasets (gitignored)
├── soundfonts/
├── configs/              # YAML: model sizes, training, mood presets
│   └── moods.yaml
├── src/
│   ├── data/             # download, instrument extraction, tokenization, attribute labeling
│   ├── models/           # transformer.py, lora.py, conductor.py, mood_engine.py, critic.py
│   ├── training/         # train_backbone.py, finetune_instrument.py, train_mood.py
│   ├── generation/       # sampler.py, constraints.py, pipeline.py
│   ├── audio/            # render.py, effects.py, mixer.py
│   └── evaluation/       # metrics.py, fad.py, controllability.py
├── app/                  # gradio_app.py
├── notebooks/            # EDA, Colab training notebooks
├── checkpoints/
├── outputs/
├── tests/
├── requirements.txt
└── README.md
```

---

## 10. Timeline (≈12 weeks; compress as needed)

| Week | Milestone |
|---|---|
| 1 | Literature review (Music Transformer, MuseNet, MMM, FIGARO, EMOPIA), env setup, download datasets |
| 2 | Data pipeline: instrument extraction, cleaning, MidiTok tokenization, attribute (control-token) labeling |
| 3 | **MVP:** small unconditional piano Transformer → render to WAV (proves the loop works) |
| 4–5 | Add control tokens; train shared backbone on Lakh (Colab) |
| 6 | Fine-tune instrument experts: piano, drums, guitar, violin, bass (LoRA) |
| 7 | Conductor (chords, structure, energy curve) + multi-track generation pipeline |
| 8 | Mood Engine: preset table + learned text→valence/arousal model |
| 9 | Audio rendering, effects, mixing, lo-fi chain; constrained decoding |
| 10 | Gradio app with all controls + piano-roll view |
| 11 | Critic/reranking, evaluation, ablations, listening test |
| 12 | Report, presentation, demo video, cleanup |

**Minimum viable version (if time runs short):** piano + drums + bass, 6 mood presets,
rule-based Mood Engine, Gradio UI. Everything else is an upgrade on top.

---

## 11. Risks & mitigations
| Risk | Mitigation |
|---|---|
| No local GPU | Train on Colab/Kaggle; keep models ≤40M params; checkpoint often |
| Generated music sounds random | Conductor shared plan, scale-constrained decoding, best-of-N critic |
| Instruments clash | Same chords/key for all; per-instrument pitch ranges; mixer EQ separation |
| Not enough labeled mood data | Auto-label via valence/arousal + rule presets; EMOPIA/VGMIDI for training |
| Lakh MIDI is noisy | Use LMD-clean, filter by length/track quality, dedupe |
| FluidSynth install on Windows | Use prebuilt binaries or run rendering in Colab/WSL |

---

## 12. Report / viva talking points
- Problem: controllable, mood-aware, multi-instrument symbolic music generation.
- Novelty: combining **text→mood→parameter mapping**, **attribute-conditioned Transformers
  with per-instrument LoRA experts**, a **shared harmonic Conductor**, and a **mood critic**
  for reranking — with user-editable energy curves.
- Key references: Music Transformer (Huang et al. 2018), Pop Music Transformer / REMI
  (Huang & Yang 2020), MMM (Ens & Pasquier 2020), FIGARO (von Rütte et al. 2023),
  EMOPIA (Hung et al. 2021), MusicGen (Copet et al. 2023), CLAP (Wu et al. 2023), LoRA (Hu et al. 2021).

---

## 13. Open questions to decide before building
1. Do you have an NVIDIA GPU locally, or will training be on Colab/Kaggle?
2. Deadline / how many weeks available?
3. Which instruments are must-haves for the demo? (suggest: piano, drums, bass, guitar, violin/strings)
4. UI: Gradio (fast) or a custom React web app (more polished, more work)?
5. Team size — solo or group? (Components split cleanly: data, models, mood engine, audio, UI)
