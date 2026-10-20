# MoodComposer: Mood-Controlled Multi-Instrument Music Generation with Conditional Transformers

**Project type:** Machine Learning — college project
**Deliverables:** web application (React), training pipeline (PyTorch / Kaggle notebook), trained model, evaluation

---

## Abstract

We present **MoodComposer**, a system that generates original multi-instrument music from a short natural-language
description of a mood (e.g. *"dark horror slow build with violin"*). A Mood Engine maps words to a blend of twelve
mood profiles and a point in valence–arousal space; a Conductor turns this into a shared musical plan (key, scale,
tempo, chord progression, song form and a per-bar energy curve); and composers generate notes for up to eight
instruments (piano, guitar, bass, drums, violin, strings, flute, synth) that all follow the same plan. Notes come
from a decoder-only Transformer trained on symbolic music (MAESTRO, Groove MIDI, Lakh MIDI) with **per-bar control
tokens** for harmony, note density, dynamics and register, and from a music-theory engine. Constrained decoding
keeps the Transformer's output well-formed, playable and in key. A critic ranks best-of-N candidates. The result is
synthesised and mixed in the browser and exported as WAV and MIDI. Every instrument exposes user controls (pitch
range, density, dynamics, tone, reverb, pan, volume) and the global "rise and drop" is drawn as a curve.
In an ablation, sharing one plan across instruments raises the share of on-beat chord tones from **0.49 to 0.96**,
confirming that independent per-instrument generation is the main cause of "bad-sounding" combined output.

---

## 1. Introduction

### 1.1 Problem
A model trained on piano music can generate piano music; the same is true for drums, violin or guitar. But
**selecting several such models and playing their outputs together sounds bad**: each one chooses its own key,
chords and rhythm, so the parts clash. Additionally, users think in *moods* ("horror", "lo-fi", "sci-fi"), not in
keys, scales or note densities. The project goal is a generator that

1. accepts mood words and selects instruments and notes automatically,
2. exposes per-instrument values (frequency/pitch range, sound/tone, volume, rise and drop),
3. produces a coherent multi-instrument piece where all parts fit together.

### 1.2 Contributions
- A **Mood Engine** mapping free text (typo-tolerant) to mood blends and valence/arousal.
- A **Conductor** that produces one shared plan, solving the inter-instrument clash problem.
- A **conditional Transformer** with per-bar control tokens learned *without manual labels* (controls are
  measured from the training data itself), plus **constrained decoding**.
- A **critic** with objective metrics for best-of-N selection and evaluation.
- A complete, browser-based application with real-time mixing and MIDI/WAV export.

---

## 2. Related work

| Work | Idea | Relation to ours |
|---|---|---|
| Music Transformer (Huang et al., 2018) | relative attention for long-term structure in symbolic music | our generator is a GPT-style Transformer on MIDI tokens |
| REMI / Pop Music Transformer (Huang & Yang, 2020) | bar/position tokens, chord tokens | our token format is REMI-like with BAR / POS / CHORD |
| MMM (Ens & Pasquier, 2020) | multi-track generation with instrument tokens | we condition on an INST token, one track at a time |
| FIGARO (von Rütte et al., 2023) | description-based control (density, instruments, chords) | our per-bar DENS / VELB / REG / CHORD control tokens |
| EMOPIA (Hung et al., 2021) | emotion-labelled piano music, valence/arousal quadrants | our mood space and quadrant accuracy metric |
| MusicGen (Copet et al., 2023) | text-to-audio generation | audio models need huge compute and offer weak per-instrument control; we generate symbolically |
| Russell (1980) | circumplex model of affect | valence/arousal mood map |

---

## 3. System design

```
text ─► Mood Engine ─► settings ─► Conductor ─► plan ─► Composers (Transformer | Theory) ─► notes
                                                                    │
                                              Critic (best of N) ◄──┘
                                                    │
                                     Synthesis (stems) ─► Mix (FX, lo-fi, master) ─► WAV / MIDI
```

### 3.1 Mood Engine (`app/src/engine/moods.js`)
- **Lexicon** of ~170 words → weighted moods and modifiers, e.g. `ghost → {horror 0.8, mysterious 0.4}`,
  `slow → tempo −18`, `drop → energy shape "build → drop"`, `vinyl → lo-fi +1`.
- **Fuzzy matching** with Damerau–Levenshtein distance (≤1 for short words, ≤2–3 for long ones) plus plural/-ing
  stemming, so `loft → lofi`, `horor → horror`, `scifi`/`sci-fi` all work. `not / no / without` negate the next word.
- **Twelve mood profiles** (Horror, Sci-Fi, Lo-Fi, Soft, Epic, Happy, Sad, Romantic, Mysterious, Energetic, Ambient,
  Jazz). Each defines valence/arousal, scales, preferred keys, tempo range, chord progressions, harmonic rhythm,
  drum style, swing, chromaticism, melody style, effects and *per-instrument presets*
  (on/off level, density, dynamics, register, tone, reverb).
- **Blending:** mood weights are normalised; numeric parameters are interpolated across the blend, categorical
  ones (scale, progression, drum style) are drawn from the dominant moods. The blend also gives a point on the
  valence/arousal map shown in the UI.
- **Instrument selection:** an instrument is enabled if its blended level ≥ 0.45 or if the user names it.

### 3.2 Conductor (`conductor.js`)
Builds the plan every instrument must follow:
- number of bars from duration and tempo (multiple of 4),
- a chord per bar from the mood's progression (with turnarounds at phrase ends),
- a per-bar **energy curve** resampled from the user's 16 control points (rise & drop),
- **sections** (Intro, Verse, Build, Drop, Breakdown, Outro) derived from the energy,
- **pre-drop bars** (a big energy jump next bar) → snare rolls, silence, noise risers and a sub "impact",
- phrase ends → drum fills.

### 3.3 Arrangement roles (`procedural.js: assignRoles`)
One melodic instrument becomes the **lead** (priority list per mood, e.g. horror → violin, sci-fi → synth),
other violin/flute parts become **counter-melodies** that fill gaps the lead leaves, piano/guitar play
**harmony/rhythm**, bass plays **bass**, strings a **pad**, synth an **arpeggio** (or pad), drums **drums**.
Each instrument's energy follows the global curve, scaled by its "follow rise/drop" slider, and instruments
enter and leave with the energy (arrangement).

### 3.4 Conditional Transformer (`training/mgtrain.py`, `gpt.js`, `mlGenerator.js`)

**Data.** MAESTRO v3 (piano), Groove MIDI (drums) and Lakh MIDI clean (all other instruments). MIDI programs are
mapped to our 8 instruments (e.g. 24–31 → guitar, 40–41 → violin, channel 10 → drums). Files with non-4/4 time
signatures are skipped. Notes are quantised to a 16th-note grid.

**Automatic control labels.** For every bar we compute
- `CHORD_r_q` — template matching (maj/min/dim/aug/sus × 12 roots) on the duration-weighted pitch-class histogram
  of *all* instruments (bass weighted ×2),
- `DENS_d` — notes in the bar for this instrument (8 buckets),
- `VELB_v` — mean velocity bucket,
- `REG_r` — mean pitch bucket.

No manual annotation is needed — the controls are measured from real music, so the model learns what "dense",
"soft" or "high register" look like for each instrument.

**Tokens** (vocabulary 289):
`BOS INST_x TEMPO_t [BAR CHORD DENS VELB REG (POS PITCH VEL DUR)*]* EOS`.

**Model.** GPT-style decoder-only Transformer: token + learned positional embeddings, N pre-LayerNorm blocks
(causal multi-head self-attention, tanh-GELU MLP ×4), final LayerNorm, output head tied to the input embedding.
Default: 6 layers, 8 heads, d = 256, context 512 (≈ 4.9 M parameters).

**Training.** AdamW (β = 0.9/0.95, weight decay 0.1), warm-up + cosine LR schedule, gradient clipping 1.0,
mixed precision on GPU, random windows starting on bar boundaries (header always kept), **random transposition
−5…+6 semitones** (pitch and chord tokens, not drums), and **instrument-balanced sampling** (instrument chosen with
probability ∝ √(data size), so piano-heavy MAESTRO does not dominate).

**Inference in the browser.** The weights are exported as float32 + a JSON index, and a ~150-line JavaScript
implementation with a **KV-cache** runs them (cost ≈ 12·L·d² multiply-adds per token). A self-test compares
the JS logits with PyTorch's at export time (max error ≈ 5·10⁻⁶).

**Constrained decoding.** For each bar the app *forces* `BAR CHORD DENS VELB REG` from the Conductor/sliders, then
samples notes with top-k (k = 16) and temperature (the "creativity" slider) under three masks:
1. *grammar* — POS → PITCH → VEL → DUR, positions strictly increasing, ≤ 6 notes per onset;
2. *range* — pitches inside the instrument's playable range shifted by the register slider (drums: kit notes only);
3. *key* — out-of-key notes (not in scale or current chord) get a logit penalty of 4.5·(1 − 0.8·chromaticism),
   so horror may use chromatic notes and lullabies may not.
Context overflow is handled by re-priming with the header + the most recent bars.

### 3.5 Theory engine (`procedural.js`)
A rule-based composer (fallback, and used for melodies in *Hybrid* mode):
- **melody**: 2-bar motifs (rhythm + interval contour) reused in an A A′ B A″ phrase structure; strong beats snap
  to chord tones, weak beats move stepwise through the scale; phrase endings land on long chord tones;
  diatonic thirds at climaxes;
- **harmony**: voice-led chord voicings (minimal movement between inversions); block chords / arpeggios /
  syncopated comping depending on energy; horror uses low clusters and sparse high "plinks";
- **guitar**: strummed voicings with per-string offsets, fingerpicking for soft moods;
- **bass**: roots, root–fifth patterns, octave 8ths, EDM off-beats, jazz walking bass with chromatic approaches;
- **drums**: nine style pattern libraries × 3 energy levels, fills, crashes on section starts, snare build-ups;
- **swing** applied to off-beat 8ths/16ths.

### 3.6 Critic (`critic.js`)
| Metric | Definition |
|---|---|
| Scale consistency | share of pitched notes in the key or current chord |
| Chord tones on beats | share of on-beat notes that are chord tones |
| Control accuracy | correlation of per-bar note count with the requested energy curve + log-ratio calibration to the density slider |
| Structure | motif repetition of the lead (ideal ≈ 60 % repeated bars) |
| Mood match | distance between requested and *estimated* valence/arousal (estimated from chord qualities, scale, register, tempo, density, velocity) |
| Pitch-class entropy, empty-bar rate | diagnostics |

Score = 0.25·scale + 0.15·chord + 0.2·control + 0.15·structure + 0.25·mood. The pipeline generates N candidates
(different seeds) and keeps the best.

### 3.7 Synthesis and mixing (`synth.js`)
All sounds are synthesised (no sample files): additive piano with pitch-dependent decay and a hammer-brightness
envelope; **Karplus–Strong** plucked guitar; saw + sub-sine bass; bowed violin/strings with formant filters and
delayed vibrato; flute with breath noise; synth lead/arp/pad patches; a synthesised drum kit. Rendering is done in
**two stages**: (1) dry stems, rendered in 4-bar chunks in separate `OfflineAudioContext`s and overlap-added
(exact, and avoids the slowdown of one huge audio graph); (2) a light mix pass with per-track volume, low-pass
"tone", pan, reverb (generated impulse response) and tempo-synced delay sends, then the master lo-fi chain
(band-limiting, tape wow & flutter, bit reduction, vinyl crackle, hiss), compressor and normalisation. Because the
stems are cached, mix sliders, mute and solo re-render in about a second.

---

## 4. Implementation

| Part | Technology |
|---|---|
| Web app | React 18 + Vite, Web Worker for generation, Web Audio API, Canvas piano roll, SVG editors |
| Model training | Python 3, PyTorch 2, mido; Kaggle notebook (GPU T4/P100) or local CPU |
| Inference | custom JavaScript GPT with KV-cache (no ML runtime dependency) |
| Export | hand-written SMF type-1 MIDI writer and 16-bit PCM WAV encoder |

The user interface has four steps — *describe*, *shape (rise & drop)*, *harmony & style*, *engine* — followed by
the output (generate / new variation, piano roll with sections, chords and energy lane, audio player, downloads,
critic report) and eight instrument cards with **composition** controls (pitch range, density, dynamics, follow
rise/drop — applied on regeneration) and **mix** controls (volume, tone, reverb, pan, mute, solo — applied live),
plus a *New part* button that re-composes a single instrument while keeping the rest.

---

## 5. Experiments and results

Full tables: [`docs/results.md`](results.md) (reproduce with `node app/scripts/evaluate.mjs`).
Protocol: 12 moods × 5 seeds, 40-second pieces, mood name as the prompt.

### 5.1 Quality (Theory engine, mean over all moods)
| Scale consistency | Chord tones on beats | Control accuracy | Structure | Mood match | Critic score |
|---|---|---|---|---|---|
| 0.98 | 0.96 | 0.68 | 0.86 | 0.72 | 0.83 |

Horror deliberately scores lower on scale consistency (0.78) because its profile allows chromaticism.

### 5.2 Controllability (Pearson r between slider value and measured output)
| Control → measured | r |
|---|---|
| density → piano notes per bar | 0.955 |
| density → drum hits per bar | 0.980 |
| dynamics → piano mean velocity | 1.000 |
| pitch range → piano mean pitch | 1.000 |
| pitch range → violin mean pitch | 0.956 |

### 5.3 Ablation: shared Conductor vs. independent instruments
| Setup | Scale consistency | Chord tones on beats |
|---|---|---|
| **Shared Conductor (ours)** | **0.978** | **0.963** |
| Independent instruments (each its own plan) | 0.736 | 0.493 |

This quantifies the problem described in the introduction: layering independently generated instruments makes
half of the on-beat notes clash with the harmony.

### 5.4 Mood quadrant accuracy
The valence/arousal estimated from the generated notes falls into the requested quadrant for **66.7 %** of pieces
(Theory engine; chance ≈ 25 %).

### 5.5 Transformer
See `docs/results.md` for the AI and Hybrid rows and the training curve on the app's *How it works* page
(validation loss / perplexity are stored inside `model.json`).

---

## 6. Discussion and limitations
- Synthesised instruments are recognisable but less realistic than sampled ones; exported MIDI can be rendered
  with any sample library or DAW for production quality.
- The mood-match metric uses a hand-designed valence/arousal estimator; a learned classifier (e.g. trained on
  EMOPIA) would be a stronger critic.
- The Transformer generates one instrument at a time conditioned on shared chords; jointly attending to the other
  tracks (multi-track attention) could improve rhythmic interplay.
- Only 4/4 time is supported.

## 7. Future work
Learned text encoder (CLAP / sentence embeddings) for open-vocabulary moods · emotion classifier trained on EMOPIA as
critic · multi-track Transformer · sampled instruments (SoundFonts) · user study (MOS listening test).

## 8. Conclusion
MoodComposer turns mood words into coherent multi-instrument music with per-instrument control. The key design
decision — one shared Conductor plan that every instrument (learned or rule-based) must follow, with
data-derived control tokens and constrained decoding for the Transformer — is what makes the instruments fit
together, as the ablation shows.

## References
1. C.-Z. A. Huang et al. *Music Transformer.* ICLR 2019.
2. Y.-S. Huang, Y.-H. Yang. *Pop Music Transformer.* ACM MM 2020.
3. J. Ens, P. Pasquier. *MMM: Exploring Conditional Multi-Track Music Generation.* 2020.
4. D. von Rütte et al. *FIGARO: Controllable Music Generation using Learned and Expert Features.* ICLR 2023.
5. H.-T. Hung et al. *EMOPIA: A Multi-Modal Pop Piano Dataset for Emotion Recognition and Emotion-based Music Generation.* ISMIR 2021.
6. J. Copet et al. *Simple and Controllable Music Generation (MusicGen).* NeurIPS 2023.
7. C. Hawthorne et al. *Enabling Factorized Piano Music Modeling and Generation with the MAESTRO Dataset.* ICLR 2019.
8. J. Gillick et al. *Learning to Groove with Inverse Sequence Transformations (Groove MIDI).* ICML 2019.
9. C. Raffel. *Learning-Based Methods for Comparing Sequences (Lakh MIDI Dataset).* PhD thesis, 2016.
10. J. A. Russell. *A circumplex model of affect.* J. Personality and Social Psychology, 1980.
11. K. Karplus, A. Strong. *Digital Synthesis of Plucked-String and Drum Timbres.* Computer Music Journal, 1983.
12. A. Vaswani et al. *Attention Is All You Need.* NeurIPS 2017.
