# 🎙 VoiceClone — clone a voice from 10 seconds of audio

A small ElevenLabs-style voice cloner. Give it **10+ seconds of one person speaking clearly** (record in the
browser or upload a file), type any text, and it speaks that text **in the cloned voice**.

This is a separate project from MoodComposer (`../app`). It has its own Python backend and runs on its own port (8000).

## How it works

```
 Browser (web/)                         Python server (server/)
 ┌──────────────────────────┐           ┌──────────────────────────────────────────┐
 │ 1. Record mic / upload    │──upload──▶│ ffmpeg → mono 22 kHz wav, trim silence    │
 │                           │           │ XTTS-v2 speaker encoder → voice latents   │
 │ 2. Type text, language,   │──text────▶│ XTTS-v2 GPT + HiFi-GAN decoder            │
 │    speed, expressiveness  │           │   conditioned on those latents → 24 kHz   │
 │ 3. Play / download WAV    │◀──wav─────│ saved to data/outputs/                    │
 └──────────────────────────┘           └──────────────────────────────────────────┘
```

* **Model:** [XTTS-v2](https://huggingface.co/coqui/XTTS-v2) (Coqui, maintained as the `coqui-tts` package).
  It clones zero-shot: no training per voice. A voice is just a speaker embedding computed from your clip,
  cached in `data/voices/<id>/latents.pt`.
* **17 languages**, including English and Hindi. A voice recorded in one language can speak another.
* Long text is split into sentences automatically.

## Run it (Windows)

Requirements: **Python 3.10–3.12** and **ffmpeg** (`winget install Gyan.FFmpeg`).
An NVIDIA GPU is strongly recommended. The CPU works, but generation is several times slower.

Double-click **`voice-cloner\run.bat`**, or from a terminal:

```bash
voice-cloner\run.bat
```

The first run does all the setup:
1. creates `voice-cloner/.venv` and installs PyTorch (the CUDA build if `nvidia-smi` exists, otherwise CPU) and the packages in `requirements.txt`;
2. asks you to accept the model license. XTTS-v2 uses the **Coqui Public Model License: non-commercial use only** (https://coqui.ai/cpml);
3. starts the server, opens **http://localhost:8000** and downloads the model (~1.8 GB) to your user cache.

Later runs skip all of that and are ready in about 20 s. The model weights and your voices/outputs (`data/`) are never committed to git.

Manual start (any OS): install `torch`/`torchaudio`, run `pip install -r requirements.txt`, then from `server/` run
`COQUI_TOS_AGREED=1 uvicorn app:app --port 8000`.

## Tips for a good clone

* 15–30 s is the sweet spot. Only 10 s works, but the clone will sound less like the speaker.
* Quiet room, one speaker, no music. Speak naturally at your normal pace.
* Raise **Expressiveness** for more emotion, lower it for a steadier, flatter read.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/status` | model state, device, languages |
| GET / POST | `/api/voices` | list / create (multipart `name`, `file`) |
| PATCH / DELETE | `/api/voices/{id}` | rename / delete |
| GET | `/api/voices/{id}/audio` | the cleaned reference clip |
| POST | `/api/generate` | `{voice_id, text, language, speed, temperature}` |
| GET | `/api/generations` | history |
| GET / DELETE | `/api/generations/{id}/audio`, `/api/generations/{id}` | play/download (`?download=true`) / delete |

## Responsible use

Only clone voices you own or have explicit permission to use. Don't use cloned voices to impersonate or deceive people.
