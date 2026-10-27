"""VoiceClone API: save reference voices, generate speech in those voices."""
import json
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from engine import LANGUAGES, VoiceEngine

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
VOICES = DATA / "voices"
OUTPUTS = DATA / "outputs"
WEB = ROOT / "web"
MIN_SECONDS = 10.0
MAX_TEXT = 2000

for d in (VOICES, OUTPUTS):
    d.mkdir(parents=True, exist_ok=True)

engine = VoiceEngine()
app = FastAPI(title="VoiceClone")


@app.on_event("startup")
def _startup():
    engine.load_async()


# ---------- helpers ----------
def _read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path, data):
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _voice_dir(voice_id):
    d = VOICES / voice_id
    if not voice_id.isalnum() or not (d / "meta.json").exists():
        raise HTTPException(404, "Voice not found")
    return d


def _to_clean_wav(src, dst):
    """Any audio format -> mono 22.05 kHz wav, rumble filtered, leading/trailing silence cut."""
    trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.1"
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
        "-ac", "1", "-ar", "22050",
        "-af", f"highpass=f=70,{trim},areverse,{trim},areverse",
        str(dst),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise HTTPException(400, f"Could not read that audio file: {result.stderr.strip()[:200]}")


# ---------- status ----------
@app.get("/api/status")
def status():
    return {**engine.status(), "min_seconds": MIN_SECONDS, "max_text": MAX_TEXT}


# ---------- voices ----------
@app.get("/api/voices")
def list_voices():
    voices = [_read_json(m) for m in VOICES.glob("*/meta.json")]
    return sorted(voices, key=lambda v: v["created"], reverse=True)


@app.post("/api/voices")
def create_voice(name: str = Form(...), file: UploadFile = File(...)):
    name = name.strip()[:60] or "Untitled voice"
    voice_id = uuid.uuid4().hex[:12]
    d = VOICES / voice_id
    d.mkdir()
    try:
        raw = d / f"upload{Path(file.filename or '').suffix or '.bin'}"
        with raw.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        ref = d / "reference.wav"
        _to_clean_wav(raw, ref)
        raw.unlink()
        duration = sf.info(str(ref)).duration
        if duration < MIN_SECONDS:
            raise HTTPException(
                400, f"Only {duration:.1f}s of speech found — please give at least {MIN_SECONDS:.0f}s of clear voice."
            )
        meta = {"id": voice_id, "name": name, "duration": round(duration, 1), "created": time.time()}
        _write_json(d / "meta.json", meta)
    except BaseException:
        shutil.rmtree(d, ignore_errors=True)
        raise
    # Pre-compute the speaker embedding so the first generation is fast.
    if engine.state == "ready":
        try:
            engine.speaker_latents(str(ref), str(d / "latents.pt"))
        except Exception as e:
            print(f"[voices] latent precompute failed: {e}")
    return meta


@app.patch("/api/voices/{voice_id}")
def rename_voice(voice_id: str, name: str = Form(...)):
    d = _voice_dir(voice_id)
    meta = _read_json(d / "meta.json")
    meta["name"] = name.strip()[:60] or meta["name"]
    _write_json(d / "meta.json", meta)
    return meta


@app.delete("/api/voices/{voice_id}")
def delete_voice(voice_id: str):
    shutil.rmtree(_voice_dir(voice_id))
    return {"ok": True}


@app.get("/api/voices/{voice_id}/audio")
def voice_audio(voice_id: str):
    return FileResponse(_voice_dir(voice_id) / "reference.wav", media_type="audio/wav")


# ---------- generation ----------
class GenerateRequest(BaseModel):
    voice_id: str
    text: str = Field(min_length=1, max_length=MAX_TEXT)
    language: str = "en"
    speed: float = Field(1.0, ge=0.5, le=2.0)
    temperature: float = Field(0.7, ge=0.1, le=1.0)


@app.post("/api/generate")
def generate(req: GenerateRequest):
    d = _voice_dir(req.voice_id)
    if req.language not in LANGUAGES:
        raise HTTPException(400, "Unsupported language")
    text = " ".join(req.text.split())
    if not text:
        raise HTTPException(400, "Text is empty")
    try:
        wav, sr, took = engine.synthesize(
            text, req.language, str(d / "reference.wav"), str(d / "latents.pt"),
            speed=req.speed, temperature=req.temperature,
        )
    except RuntimeError as e:
        raise HTTPException(503, str(e))

    gen_id = uuid.uuid4().hex[:12]
    sf.write(str(OUTPUTS / f"{gen_id}.wav"), wav, sr)
    meta = {
        "id": gen_id,
        "voice_id": req.voice_id,
        "voice_name": _read_json(d / "meta.json")["name"],
        "text": text,
        "language": req.language,
        "speed": req.speed,
        "temperature": req.temperature,
        "duration": round(len(wav) / sr, 1),
        "took": round(took, 1),
        "created": time.time(),
    }
    _write_json(OUTPUTS / f"{gen_id}.json", meta)
    return meta


@app.get("/api/generations")
def list_generations():
    gens = [_read_json(m) for m in OUTPUTS.glob("*.json")]
    return sorted(gens, key=lambda g: g["created"], reverse=True)[:50]


def _gen_path(gen_id, ext):
    p = OUTPUTS / f"{gen_id}.{ext}"
    if not gen_id.isalnum() or not p.exists():
        raise HTTPException(404, "Generation not found")
    return p


@app.get("/api/generations/{gen_id}/audio")
def generation_audio(gen_id: str, download: bool = False):
    p = _gen_path(gen_id, "wav")
    return FileResponse(p, media_type="audio/wav", filename=f"voiceclone-{gen_id}.wav" if download else None)


@app.delete("/api/generations/{gen_id}")
def delete_generation(gen_id: str):
    _gen_path(gen_id, "wav").unlink()
    _gen_path(gen_id, "json").unlink()
    return {"ok": True}


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
