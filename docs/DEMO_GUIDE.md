# Demo & viva guide (5–7 minutes)

## Before the demo
```bash
cd app
npm install      # once
npm run dev      # open http://localhost:5173
```
Check the top-right badge says **AI model loaded** (model files in `app/public/models/`).
Use headphones or speakers — the audio is the point!

## Demo flow
1. **The problem (30 s).** "If you train one model per instrument and play them together, it sounds bad —
   every model picks its own key and chords." Show `docs/results.md` §4: chord-tone agreement 0.49 vs 0.96.
2. **Words → mood (1 min).** Type `dark horor slow build with violin` (typo on purpose).
   Point at: fuzzy match `horor → horror`, the mood blend bars, the dot on the valence/arousal map,
   and how instruments switched on automatically (violin, strings, low piano…).
3. **Generate (1 min).** Click **Generate music**. While it plays, explain the piano roll:
   sections on top (Intro → Build → …), chord names, coloured notes per instrument, drums lane, energy lane.
4. **Rise & drop (1 min).** Pick the *Build → Drop* preset, change the prompt to `sci-fi spaceship`, generate.
   Point out the riser + silence before the drop and the impact on the drop.
5. **Per-instrument control (1 min).** Mute drums / solo violin (instant remix). Move the violin *Pitch range* to
   "very high", press **↻ New part** — only the violin changes.
6. **AI vs Theory (1 min).** Switch *Composer* to *AI Transformer*, generate `lofi rainy study beats`.
   Show the instrument cards now say "AI". Open **How it works** → model size, training curve.
7. **Export (15 s).** Download the MIDI and drop it into any DAW / MuseScore.

## Likely viva questions
- **Why symbolic (MIDI) and not raw audio?** Trainable on a free GPU in an hour, exact per-instrument
  control, notes can be checked against music theory; audio models (MusicGen) need far more compute.
- **What are control tokens?** Per-bar tokens (chord, density, dynamics, register) *measured* from the
  training data. The model learns their meaning; at generation time we set them from the mood + sliders.
- **What is constrained decoding?** Masks applied to the logits before sampling: token grammar, instrument
  pitch range, and a penalty for out-of-key notes.
- **How do you know the output matches the mood?** Critic: estimated valence/arousal from the notes vs the
  requested one (66.7 % quadrant accuracy vs 25 % chance), plus quality metrics and best-of-N selection.
- **Why does the JS model give the same result as PyTorch?** Export includes a self-test: logits for a fixed
  input; the browser recomputes them (max error ≈ 1e-5).
- **Limitations?** Synthesised timbres, 4/4 only, one-track-at-a-time Transformer, heuristic mood estimator.
