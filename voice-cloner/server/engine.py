"""XTTS-v2 wrapper: loads the model once, clones a voice from a reference clip
and synthesises speech in that voice."""
import os
import threading
import time

import numpy as np
import torch

MODEL_NAME = "tts_models/multilingual/multi-dataset/xtts_v2"
SAMPLE_RATE = 24000

LANGUAGES = {
    "en": "English", "hi": "Hindi", "es": "Spanish", "fr": "French",
    "de": "German", "it": "Italian", "pt": "Portuguese", "pl": "Polish",
    "tr": "Turkish", "ru": "Russian", "nl": "Dutch", "cs": "Czech",
    "ar": "Arabic", "zh-cn": "Chinese", "ja": "Japanese", "hu": "Hungarian",
    "ko": "Korean",
}


class VoiceEngine:
    def __init__(self):
        self.model = None
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.state = "idle"  # idle | loading | ready | error
        self.error = None
        self._lock = threading.Lock()

    # ---------- loading ----------
    def load_async(self):
        if self.state in ("loading", "ready"):
            return
        threading.Thread(target=self._load, daemon=True).start()

    def _load(self):
        self.state = "loading"
        try:
            if os.environ.get("COQUI_TOS_AGREED") != "1":
                raise RuntimeError(
                    "XTTS-v2 is released under the Coqui Public Model License "
                    "(non-commercial). Read https://coqui.ai/cpml and, if you agree, "
                    "set COQUI_TOS_AGREED=1 before starting the server."
                )
            from TTS.api import TTS

            tts = TTS(MODEL_NAME, progress_bar=True).to(self.device)
            self.model = tts.synthesizer.tts_model
            self.state = "ready"
            print(f"[engine] XTTS-v2 ready on {self.device}")
        except Exception as e:  # surfaced to the UI via /api/status
            self.error = str(e)
            self.state = "error"
            print(f"[engine] failed to load: {e}")

    def status(self):
        return {
            "state": self.state,
            "error": self.error,
            "device": self.device,
            "gpu": torch.cuda.get_device_name(0) if self.device == "cuda" else None,
            "languages": LANGUAGES,
        }

    def _require_ready(self):
        if self.state != "ready":
            raise RuntimeError(self.error or f"Model is {self.state}, try again shortly")

    # ---------- cloning ----------
    def speaker_latents(self, reference_wav, cache_path):
        """Compute (and cache) the speaker conditioning for a reference clip."""
        if os.path.exists(cache_path):
            data = torch.load(cache_path, map_location=self.device)
            return data["gpt"], data["spk"]
        self._require_ready()
        with self._lock:
            gpt, spk = self.model.get_conditioning_latents(
                audio_path=[reference_wav], max_ref_length=30, sound_norm_refs=True
            )
        torch.save({"gpt": gpt.cpu(), "spk": spk.cpu()}, cache_path)
        return gpt.to(self.device), spk.to(self.device)

    def synthesize(self, text, language, reference_wav, cache_path,
                   speed=1.0, temperature=0.7):
        self._require_ready()
        gpt, spk = self.speaker_latents(reference_wav, cache_path)
        gpt, spk = gpt.to(self.device), spk.to(self.device)
        start = time.time()
        with self._lock, torch.inference_mode():
            out = self.model.inference(
                text,
                language,
                gpt,
                spk,
                temperature=temperature,
                speed=speed,
                repetition_penalty=5.0,
                enable_text_splitting=True,
            )
        wav = np.asarray(out["wav"], dtype=np.float32)
        peak = float(np.max(np.abs(wav))) or 1.0
        wav = wav / peak * 0.95
        return wav, SAMPLE_RATE, time.time() - start
