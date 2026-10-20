# %% [markdown]
# # MoodComposer — Conditional Music Transformer (training notebook)
#
# Trains ONE GPT-style Transformer that generates notes for 8 instruments
# (piano, guitar, bass, drums, violin, strings, flute, synth). Generation is
# conditioned on control tokens that are computed automatically from real music:
#
# * `INST_*`   — which instrument to play
# * `TEMPO_*`  — tempo bucket
# * per bar: `CHORD_*` (harmony), `DENS_*` (notes per bar), `VELB_*` (dynamics), `REG_*` (pitch register)
#
# At generation time the web app's Mood Engine + Conductor set these tokens
# (e.g. "horror" → minor/diminished chords, low register, sparse density), so the
# model's output follows the requested mood, energy curve and per-instrument sliders.
#
# **Kaggle setup:** Settings → Accelerator → *GPU T4 x2* (or P100), Internet → *On*.
# Run all cells. Download `model.json` + `model.bin` from `/kaggle/working/export/`
# and put them into `app/public/models/` of the web app.

# %%
import glob
import json
import math
import os
import random
import sys
import tarfile
import time
import urllib.request
import zipfile
from multiprocessing import Pool

import numpy as np

try:
    import mido
except ImportError:  # Kaggle: install on the fly
    os.system(f"{sys.executable} -m pip install -q mido")
    import mido

import torch
import torch.nn as nn
import torch.nn.functional as F

IN_KAGGLE = os.path.exists("/kaggle")
WORK = "/kaggle/working" if IN_KAGGLE else os.path.join(os.path.dirname(os.path.abspath(globals().get("__file__", "./x"))), "work")
os.makedirs(WORK, exist_ok=True)

# %% [markdown]
# ## 1. Configuration

# %%
CONFIG = dict(
    datasets=["maestro", "groove", "lakh"],  # which datasets to download (lakh is ~1.7 GB unpacked)
    max_lakh_files=8000,  # cap to keep preprocessing fast
    n_layer=6,
    n_head=8,
    d_model=256,
    block_size=512,
    dropout=0.1,
    batch_size=48,
    lr=4e-4,
    warmup=500,
    max_steps=16000,  # ~45–70 min on a T4
    eval_every=1000,
    seed=1234,
)
SMOKE = "--smoke" in sys.argv  # local CPU smoke test with synthetic MIDI
LOCAL = "--local" in sys.argv  # small "starter" model that trains on a laptop CPU in ~1 h
if SMOKE:
    CONFIG.update(n_layer=2, n_head=4, d_model=64, block_size=128, batch_size=8, max_steps=60, eval_every=30, warmup=10)
elif LOCAL:
    CONFIG.update(n_layer=4, n_head=6, d_model=192, block_size=384, batch_size=16, max_steps=3500, eval_every=500,
                  warmup=200, lr=6e-4, max_lakh_files=3000, max_files_per_dataset=700)

random.seed(CONFIG["seed"])
np.random.seed(CONFIG["seed"])
torch.manual_seed(CONFIG["seed"])

# %% [markdown]
# ## 2. Tokenizer (must match `app/src/engine/tokenizer.js`)
#
# Sequence layout for one instrument track:
# ```
# BOS INST_x TEMPO_t  [BAR CHORD_c DENS_d VELB_v REG_r  (POS_p PITCH_n VEL_v DUR_d)* ]*  EOS
# ```

# %%
INSTRUMENTS = ["piano", "guitar", "bass", "drums", "violin", "strings", "flute", "synth"]
QUALITIES = ["maj", "min", "dim", "aug", "sus"]
DENS_THRESH = [0, 1, 3, 5, 8, 12, 17, 24]  # notes-per-bar bucket lower bounds


def build_vocab():
    v = ["PAD", "BOS", "EOS", "BAR"]
    v += [f"INST_{i}" for i in INSTRUMENTS]
    v += [f"TEMPO_{i}" for i in range(8)]
    v += ["CHORD_N"] + [f"CHORD_{r}_{q}" for r in range(12) for q in QUALITIES]
    v += [f"DENS_{i}" for i in range(8)]
    v += [f"VELB_{i}" for i in range(8)]
    v += [f"REG_{i}" for i in range(8)]
    v += [f"POS_{i}" for i in range(16)]
    v += [f"PITCH_{i}" for i in range(128)]
    v += [f"VEL_{i}" for i in range(8)]
    v += [f"DUR_{i}" for i in range(1, 33)]
    return v


VOCAB = build_vocab()
TOK = {t: i for i, t in enumerate(VOCAB)}
V = len(VOCAB)


def tempo_bucket(bpm):
    return int(min(7, max(0, (bpm - 50) // 20)))


def dens_bucket(n):
    b = 0
    for i, t in enumerate(DENS_THRESH):
        if n >= t:
            b = i
    return b


def vel_bucket(v):
    return int(min(7, max(0, v // 16)))


def reg_bucket(mean_pitch):
    return int(min(7, max(0, (mean_pitch - 28) // 10)))


def program_to_instrument(program, channel):
    if channel == 9:
        return "drums"
    if 0 <= program <= 7:
        return "piano"
    if 24 <= program <= 31:
        return "guitar"
    if 32 <= program <= 39:
        return "bass"
    if program in (40, 41):
        return "violin"
    if 42 <= program <= 55:
        return "strings"
    if 72 <= program <= 79:
        return "flute"
    if 80 <= program <= 95:
        return "synth"
    return None


print("vocab size:", V)

# %% [markdown]
# ## 3. Download datasets
# MAESTRO (piano), Groove MIDI (drums), Lakh MIDI *clean* (multi-instrument: guitar, bass,
# violin, strings, flute, synth…). Any `.mid` files attached under `/kaggle/input` are used too.

# %%
URLS = {
    "maestro": "https://storage.googleapis.com/magentadata/datasets/maestro/v3.0.0/maestro-v3.0.0-midi.zip",
    "groove": "https://storage.googleapis.com/magentadata/datasets/groove/groove-v1.0.0-midionly.zip",
    "lakh": "http://hog.ee.columbia.edu/craffel/lmd/clean_midi.tar.gz",
}


def download_and_extract(name, url, root):
    dest = os.path.join(root, name)
    if os.path.exists(dest) and any(True for _ in glob.iglob(dest + "/**/*.mid*", recursive=True)):
        print(f"[{name}] already present")
        return dest
    os.makedirs(dest, exist_ok=True)
    archive = os.path.join(root, os.path.basename(url))
    for attempt in range(4):
        try:
            print(f"[{name}] downloading {url}")
            urllib.request.urlretrieve(url, archive)
            break
        except Exception as e:
            if attempt == 3:
                raise
            print(f"[{name}] retry after error: {e}")
            time.sleep(5 * (attempt + 1))
    print(f"[{name}] extracting")
    bad = '<>:"|?*'
    safe = lambda n: "".join("_" if (c in bad or ord(c) < 32) else c for c in n).rstrip(". ")

    def write_member(name, data):
        parts = [safe(p) for p in name.replace("\\", "/").split("/") if p not in ("", ".", "..")]
        if not parts or not parts[-1].lower().endswith((".mid", ".midi")):
            return
        path = os.path.join(dest, *parts)
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(data)
        except OSError:
            pass  # skip names the filesystem refuses

    if archive.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                if not info.is_dir():
                    write_member(info.filename, z.read(info))
    else:
        with tarfile.open(archive) as t:
            for m in t:
                if m.isfile():
                    write_member(m.name, t.extractfile(m).read())
    os.remove(archive)
    return dest


def collect_midi_files():
    files = {}
    data_root = os.path.join(WORK, "data")
    os.makedirs(data_root, exist_ok=True)
    for name in CONFIG["datasets"]:
        try:
            d = download_and_extract(name, URLS[name], data_root)
            fs = sorted(glob.glob(d + "/**/*.mid", recursive=True) + glob.glob(d + "/**/*.midi", recursive=True))
            if name == "lakh":
                random.shuffle(fs)
                fs = fs[: CONFIG["max_lakh_files"]]
            elif CONFIG.get("max_files_per_dataset"):
                random.shuffle(fs)
                fs = fs[: CONFIG["max_files_per_dataset"]]
            files[name] = fs
        except Exception as e:  # keep going if one source fails
            print(f"[{name}] FAILED: {e}")
    if IN_KAGGLE:
        extra = glob.glob("/kaggle/input/**/*.mid", recursive=True) + glob.glob("/kaggle/input/**/*.midi", recursive=True)
        if extra:
            files["kaggle_input"] = extra
    for k, v in files.items():
        print(f"{k}: {len(v)} files")
    return [f for v in files.values() for f in v]


# %% [markdown]
# ## 4. MIDI → per-instrument token sequences
# Notes are quantised to a 16th-note grid (4/4). For each bar we detect the chord
# (template matching on the pitch-class histogram of ALL instruments) and compute the
# density / dynamics / register control values for each instrument.

# %%
CHORD_TEMPLATES = {"maj": [0, 4, 7], "min": [0, 3, 7], "dim": [0, 3, 6], "aug": [0, 4, 8], "sus": [0, 5, 7]}


def detect_chord(hist):
    total = hist.sum()
    if total < 1e-6:
        return "CHORD_N"
    best, best_score = "CHORD_N", 0.35
    for r in range(12):
        for q, tpl in CHORD_TEMPLATES.items():
            pcs = [(r + i) % 12 for i in tpl]
            inside = hist[pcs].sum()
            score = (inside - 0.6 * (total - inside)) / total + 0.05 * hist[r] / total
            if score > best_score:
                best, best_score = f"CHORD_{r}_{q}", score
    return best


def parse_midi(path):
    """Return list of (instrument, tokens) for one file, or [] if unusable."""
    try:
        if os.path.getsize(path) > 1_500_000:
            return []
        mid = mido.MidiFile(path, clip=True)
    except Exception:
        return []
    if mid.type == 2 or mid.ticks_per_beat <= 0:
        return []
    tpb = mid.ticks_per_beat
    step_ticks = tpb / 4.0
    bpm = None
    notes = {}  # instrument -> list of (step, dur, pitch, vel)
    for track in mid.tracks:
        tick = 0
        program = [0] * 16
        active = {}
        for msg in track:
            tick += msg.time
            if msg.type == "set_tempo" and bpm is None:
                bpm = mido.tempo2bpm(msg.tempo)
            elif msg.type == "time_signature":
                if (msg.numerator, msg.denominator) not in ((4, 4), (2, 4), (2, 2)):
                    return []
            elif msg.type == "program_change":
                program[msg.channel] = msg.program
            elif msg.type == "note_on" and msg.velocity > 0:
                active.setdefault((msg.channel, msg.note), []).append((tick, msg.velocity, program[msg.channel]))
            elif msg.type in ("note_off", "note_on"):
                key = (msg.channel, msg.note)
                if active.get(key):
                    start, vel, prog = active[key].pop(0)
                    inst = program_to_instrument(prog, msg.channel)
                    if inst is None:
                        continue
                    s = int(round(start / step_ticks))
                    d = int(round((tick - start) / step_ticks))
                    d = 1 if d < 1 else (32 if d > 32 else d)
                    if inst == "drums" and not (27 <= msg.note <= 87):
                        continue
                    notes.setdefault(inst, []).append((s, d, msg.note, vel))
    if not notes:
        return []
    bpm = bpm or 120.0
    last_step = max(n[0] for ns in notes.values() for n in ns)
    n_bars = last_step // 16 + 1
    if n_bars < 4 or n_bars > 2000:
        return []

    # chord per bar from all pitched instruments
    hists = np.zeros((n_bars, 12), dtype=np.float32)
    for inst, ns in notes.items():
        if inst == "drums":
            continue
        for s, d, p, v in ns:
            b = s // 16
            hists[b, p % 12] += min(d, 16 - s % 16) * (2.0 if inst == "bass" else 1.0)
    chords = [detect_chord(h) for h in hists]
    tb = tempo_bucket(bpm)

    out = []
    for inst, ns in notes.items():
        if len(ns) < 16:
            continue
        ns = sorted(set(ns), key=lambda n: (n[0], n[2]))
        by_bar = {}
        for n in ns:
            by_bar.setdefault(n[0] // 16, []).append(n)
        bars_with = sorted(by_bar)
        first, last = bars_with[0], bars_with[-1]
        if last - first + 1 < 4:
            continue
        toks = [TOK["BOS"], TOK[f"INST_{inst}"], TOK[f"TEMPO_{tb}"]]
        for b in range(first, last + 1):
            bn = by_bar.get(b, [])[:32]
            toks.append(TOK["BAR"])
            toks.append(TOK[chords[b]])
            toks.append(TOK[f"DENS_{dens_bucket(len(bn))}"])
            toks.append(TOK[f"VELB_{vel_bucket(int(np.mean([n[3] for n in bn])) if bn else 0)}"])
            toks.append(TOK[f"REG_{reg_bucket(np.mean([n[2] for n in bn]) if bn else 28)}"])
            last_pos = -1
            for s, d, p, v in bn:
                pos = s % 16
                if pos != last_pos:
                    toks.append(TOK[f"POS_{pos}"])
                    last_pos = pos
                toks += [TOK[f"PITCH_{p}"], TOK[f"VEL_{vel_bucket(v)}"], TOK[f"DUR_{d}"]]
        toks.append(TOK["EOS"])
        out.append((inst, np.array(toks, dtype=np.int16)))
    return out


def build_dataset(files):
    t0 = time.time()
    # Windows uses "spawn" for multiprocessing, which would re-run this notebook-style script.
    procs = 1 if os.name == "nt" else max(1, (os.cpu_count() or 2))
    seqs = []
    if procs > 1 and len(files) > 50:
        with Pool(procs) as pool:
            for res in pool.imap_unordered(parse_midi, files, chunksize=16):
                seqs.extend(res)
    else:
        for f in files:
            seqs.extend(parse_midi(f))
    counts = {}
    for inst, s in seqs:
        counts[inst] = counts.get(inst, 0) + 1
    print(f"parsed {len(files)} files → {len(seqs)} tracks in {time.time() - t0:.0f}s; per instrument: {counts}")
    return seqs


# %% [markdown]
# ## 5. Training windows + transposition augmentation

# %%
PITCH0 = TOK["PITCH_0"]
CHORD0 = TOK["CHORD_0_maj"]


def make_transpose_tables():
    tables = {}
    for k in range(-5, 7):
        t = np.arange(V, dtype=np.int64)
        for p in range(128):
            q = p + k
            t[PITCH0 + p] = PITCH0 + q if 0 <= q < 128 else PITCH0 + p
        for r in range(12):
            for qi in range(len(QUALITIES)):
                t[CHORD0 + r * len(QUALITIES) + qi] = CHORD0 + ((r + k) % 12) * len(QUALITIES) + qi
        tables[k] = t
    return tables


TRANSPOSE = make_transpose_tables()
DRUM_INST = TOK["INST_drums"]
BAR = TOK["BAR"]


class WindowSampler:
    """Random windows that start on a bar boundary and always keep the BOS/INST/TEMPO header."""

    def __init__(self, seqs, block):
        self.block = block
        self.seqs = [s.astype(np.int64) for _, s in seqs]
        self.bar_starts = [np.where(s == BAR)[0] for s in self.seqs]
        # balance instruments: pick an instrument uniformly (sqrt-tempered), then a track ∝ its length
        self.by_inst = {}
        for j, (inst, _) in enumerate(seqs):
            self.by_inst.setdefault(inst, []).append(j)
        self.insts = sorted(self.by_inst)
        w = np.array([math.sqrt(sum(len(self.seqs[j]) for j in self.by_inst[i])) for i in self.insts])
        self.inst_p = w / w.sum()
        self.track_p = {}
        for inst in self.insts:
            lengths = np.array([len(self.seqs[j]) for j in self.by_inst[inst]], dtype=np.float64)
            self.track_p[inst] = lengths / lengths.sum()

    def sample(self, batch):
        x = np.full((batch, self.block + 1), TOK["PAD"], dtype=np.int64)
        for i in range(batch):
            inst = self.insts[np.random.choice(len(self.insts), p=self.inst_p)]
            j = self.by_inst[inst][np.random.choice(len(self.by_inst[inst]), p=self.track_p[inst])]
            s, bars = self.seqs[j], self.bar_starts[j]
            start = bars[np.random.randint(len(bars))] if len(bars) else 3
            # prefer starts that leave a full window
            if len(s) - start < self.block and len(bars) > 1:
                ok = bars[bars <= max(3, len(s) - self.block)]
                if len(ok):
                    start = ok[np.random.randint(len(ok))]
            body = s[start : start + self.block + 1 - 3]
            w = np.concatenate([s[:3], body])
            if s[1] != DRUM_INST:
                w = TRANSPOSE[np.random.randint(-5, 7)][w]
            x[i, : len(w)] = w
        x = torch.from_numpy(x)
        return x[:, :-1], x[:, 1:]


# %% [markdown]
# ## 6. Model — GPT-style decoder-only Transformer
# Pre-LayerNorm blocks, learned positional embeddings, tanh-GELU MLP, tied input/output
# embeddings. Kept deliberately standard so the exported weights can be run by the small
# JavaScript inference engine in the browser (`app/src/engine/gpt.js`, with KV-cache).

# %%
class Block(nn.Module):
    def __init__(self, d, h, dropout):
        super().__init__()
        self.h = h
        self.ln1 = nn.LayerNorm(d)
        self.qkv = nn.Linear(d, 3 * d)
        self.proj = nn.Linear(d, d)
        self.ln2 = nn.LayerNorm(d)
        self.fc = nn.Linear(d, 4 * d)
        self.fc_proj = nn.Linear(4 * d, d)
        self.drop = nn.Dropout(dropout)
        self.dropout = dropout

    def forward(self, x):
        B, T, C = x.shape
        q, k, v = self.qkv(self.ln1(x)).split(C, dim=2)
        q = q.view(B, T, self.h, C // self.h).transpose(1, 2)
        k = k.view(B, T, self.h, C // self.h).transpose(1, 2)
        v = v.view(B, T, self.h, C // self.h).transpose(1, 2)
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True, dropout_p=self.dropout if self.training else 0.0)
        y = y.transpose(1, 2).contiguous().view(B, T, C)
        x = x + self.drop(self.proj(y))
        x = x + self.drop(self.fc_proj(F.gelu(self.fc(self.ln2(x)), approximate="tanh")))
        return x


class MusicGPT(nn.Module):
    def __init__(self, vocab, block, n_layer, n_head, d_model, dropout):
        super().__init__()
        self.block = block
        self.wte = nn.Embedding(vocab, d_model)
        self.wpe = nn.Embedding(block, d_model)
        self.drop = nn.Dropout(dropout)
        self.blocks = nn.ModuleList([Block(d_model, n_head, dropout) for _ in range(n_layer)])
        self.lnf = nn.LayerNorm(d_model)
        self.apply(self._init)

    @staticmethod
    def _init(m):
        if isinstance(m, (nn.Linear, nn.Embedding)):
            nn.init.normal_(m.weight, std=0.02)
        if isinstance(m, nn.Linear) and m.bias is not None:
            nn.init.zeros_(m.bias)

    def forward(self, idx):
        B, T = idx.shape
        pos = torch.arange(T, device=idx.device)
        x = self.drop(self.wte(idx) + self.wpe(pos))
        for b in self.blocks:
            x = b(x)
        return self.lnf(x) @ self.wte.weight.T  # tied output head


# %% [markdown]
# ## 7. Build data + train

# %%
def synthetic_midis(n, root):
    """Smoke-test data: random progressions with piano, bass, drums, violin."""
    os.makedirs(root, exist_ok=True)
    paths = []
    for f in range(n):
        mid = mido.MidiFile(ticks_per_beat=96)
        prog = random.choice([[0, 5, 7, 9], [9, 5, 0, 7], [2, 7, 0, 0]])
        key = random.randint(0, 11)
        for inst_prog, ch, kind in [(0, 0, "chord"), (33, 1, "bass"), (0, 9, "drums"), (40, 2, "mel")]:
            tr = mido.MidiTrack()
            mid.tracks.append(tr)
            if f == 0 and ch == 0:
                tr.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(random.choice([80, 100, 120]))))
            if ch != 9:
                tr.append(mido.Message("program_change", program=inst_prog, channel=ch, time=0))
            events = []
            for bar in range(16):
                r = key + prog[bar % 4]
                t0 = bar * 4 * 96
                if kind == "chord":
                    for p in (60 + r % 12, 64 + r % 12, 67 + r % 12):
                        events.append((t0, t0 + 380, p, 70))
                elif kind == "bass":
                    for b in range(4):
                        events.append((t0 + b * 96, t0 + b * 96 + 90, 36 + r % 12, 90))
                elif kind == "drums":
                    for b in range(8):
                        events.append((t0 + b * 48, t0 + b * 48 + 20, 42, 60))
                    events += [(t0, t0 + 20, 36, 100), (t0 + 96, t0 + 116, 38, 100), (t0 + 192, t0 + 212, 36, 100), (t0 + 288, t0 + 308, 38, 100)]
                else:
                    for b in range(8):
                        events.append((t0 + b * 48, t0 + b * 48 + 44, 72 + random.choice([0, 2, 4, 5, 7]) + r % 12 - 12, 80))
            msgs = []
            for s, e, p, v in events:
                msgs.append((s, mido.Message("note_on", note=p, velocity=v, channel=ch)))
                msgs.append((e, mido.Message("note_off", note=p, velocity=0, channel=ch)))
            msgs.sort(key=lambda m: m[0])
            last = 0
            for t, m in msgs:
                m.time = t - last
                last = t
                tr.append(m)
        path = os.path.join(root, f"synth_{f}.mid")
        mid.save(path)
        paths.append(path)
    return paths


if SMOKE:
    FILES = synthetic_midis(24, os.path.join(WORK, "smoke_midis"))
else:
    FILES = collect_midi_files()

random.shuffle(FILES)
n_val = max(1, len(FILES) // 50)
import pickle

cache = os.path.join(WORK, f"dataset_{'smoke' if SMOKE else 'local' if LOCAL else 'full'}_{len(FILES)}.pkl")
if os.path.exists(cache):
    with open(cache, "rb") as f:
        train_seqs, val_seqs = pickle.load(f)
    print("loaded cached dataset", cache)
else:
    train_seqs = build_dataset(FILES[n_val:])
    val_seqs = build_dataset(FILES[:n_val]) or train_seqs[:5]
    with open(cache, "wb") as f:
        pickle.dump((train_seqs, val_seqs), f)

# %%
device = "cuda" if torch.cuda.is_available() else "cpu"
print("device:", device)
model = MusicGPT(V, CONFIG["block_size"], CONFIG["n_layer"], CONFIG["n_head"], CONFIG["d_model"], CONFIG["dropout"]).to(device)
print(f"parameters: {sum(p.numel() for p in model.parameters()) / 1e6:.2f}M")

train_sampler = WindowSampler(train_seqs, CONFIG["block_size"])
val_sampler = WindowSampler(val_seqs, CONFIG["block_size"])
opt = torch.optim.AdamW(model.parameters(), lr=CONFIG["lr"], betas=(0.9, 0.95), weight_decay=0.1)
use_amp = device == "cuda"
scaler = torch.amp.GradScaler("cuda") if use_amp else None


def lr_at(step):
    if step < CONFIG["warmup"]:
        return CONFIG["lr"] * (step + 1) / CONFIG["warmup"]
    t = (step - CONFIG["warmup"]) / max(1, CONFIG["max_steps"] - CONFIG["warmup"])
    return CONFIG["lr"] * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * t)))


def loss_fn(logits, y):
    return F.cross_entropy(logits.reshape(-1, V), y.reshape(-1), ignore_index=TOK["PAD"])


@torch.no_grad()
def evaluate(n=20):
    model.eval()
    losses = []
    for _ in range(n):
        x, y = val_sampler.sample(CONFIG["batch_size"])
        x, y = x.to(device), y.to(device)
        with torch.autocast(device_type="cuda", dtype=torch.float16, enabled=use_amp):
            losses.append(loss_fn(model(x), y).item())
    model.train()
    return float(np.mean(losses))


history = []
best_val = float("inf")
ckpt_path = os.path.join(WORK, "best.pt")
t0 = time.time()
model.train()
for step in range(CONFIG["max_steps"]):
    for g in opt.param_groups:
        g["lr"] = lr_at(step)
    x, y = train_sampler.sample(CONFIG["batch_size"])
    x, y = x.to(device), y.to(device)
    with torch.autocast(device_type="cuda", dtype=torch.float16, enabled=use_amp):
        loss = loss_fn(model(x), y)
    opt.zero_grad(set_to_none=True)
    if use_amp:
        scaler.scale(loss).backward()
        scaler.unscale_(opt)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        scaler.step(opt)
        scaler.update()
    else:
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
    if step % 100 == 0:
        print(f"step {step:6d}  loss {loss.item():.3f}  lr {lr_at(step):.2e}  {time.time() - t0:.0f}s")
    if (step + 1) % CONFIG["eval_every"] == 0 or step == CONFIG["max_steps"] - 1:
        vl = evaluate()
        history.append({"step": step + 1, "train_loss": loss.item(), "val_loss": vl, "val_ppl": math.exp(vl)})
        print(f"  >> val loss {vl:.3f}  ppl {math.exp(vl):.2f}")
        if vl < best_val:
            best_val = vl
            torch.save(model.state_dict(), ckpt_path)

model.load_state_dict(torch.load(ckpt_path, map_location=device))
print("best val loss", best_val)

# %% [markdown]
# ## 8. Quick sample (sanity check) — unconstrained sampling from a piano header

# %%
@torch.no_grad()
def sample_tokens(prefix, n=200, temperature=1.0, top_k=20):
    model.eval()
    idx = torch.tensor([prefix], device=device)
    for _ in range(n):
        logits = model(idx[:, -CONFIG["block_size"] :])[:, -1, :] / temperature
        v, _ = torch.topk(logits, top_k)
        logits[logits < v[:, [-1]]] = -float("inf")
        nxt = torch.multinomial(F.softmax(logits, dim=-1), 1)
        idx = torch.cat([idx, nxt], dim=1)
        if nxt.item() == TOK["EOS"]:
            break
    return [VOCAB[i] for i in idx[0].tolist()]


demo = sample_tokens([TOK["BOS"], TOK["INST_piano"], TOK["TEMPO_2"], TOK["BAR"], TOK["CHORD_0_maj"], TOK["DENS_4"], TOK["VELB_4"], TOK["REG_3"]], n=80)
print(" ".join(demo))

# %% [markdown]
# ## 9. Export weights for the web app
# Writes `model.json` (config, vocab, tensor index, self-test logits) and `model.bin`
# (float32 little-endian). Copy both into `app/public/models/`.

# %%
def export(model, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    model = model.float().cpu().eval()
    sd = model.state_dict()
    order = ["wte.weight", "wpe.weight"]
    for i in range(CONFIG["n_layer"]):
        for n in ["ln1.weight", "ln1.bias", "qkv.weight", "qkv.bias", "proj.weight", "proj.bias",
                  "ln2.weight", "ln2.bias", "fc.weight", "fc.bias", "fc_proj.weight", "fc_proj.bias"]:
            order.append(f"blocks.{i}.{n}")
    order += ["lnf.weight", "lnf.bias"]
    index, offset = {}, 0
    with open(os.path.join(out_dir, "model.bin"), "wb") as f:
        for name in order:
            t = sd[name].numpy().astype("<f4")
            f.write(t.tobytes())
            index[name] = {"offset": offset, "shape": list(t.shape)}
            offset += t.size
    test_ids = [TOK["BOS"], TOK["INST_piano"], TOK["TEMPO_3"], TOK["BAR"], TOK["CHORD_0_maj"], TOK["DENS_3"],
                TOK["VELB_4"], TOK["REG_3"], TOK["POS_0"], TOK["PITCH_60"], TOK["VEL_4"], TOK["DUR_4"]]
    with torch.no_grad():
        logits = model(torch.tensor([test_ids]))[0, -1].tolist()
    meta = {
        "format": "moodcomposer-gpt-v1",
        "config": {k: CONFIG[k] for k in ["n_layer", "n_head", "d_model", "block_size"]} | {"vocab_size": V},
        "vocab": VOCAB,
        "tensors": index,
        "selftest": {"ids": test_ids, "logits": [round(x, 5) for x in logits]},
        "training": {"history": history, "best_val_loss": best_val, "tracks": len(train_seqs), "files": len(FILES),
                     "instrument_tracks": {i: sum(1 for n, _ in train_seqs if n == i) for i in INSTRUMENTS}},
    }
    with open(os.path.join(out_dir, "model.json"), "w") as f:
        json.dump(meta, f)
    size = os.path.getsize(os.path.join(out_dir, "model.bin")) / 1e6
    print(f"exported to {out_dir}  ({size:.1f} MB)")


export(model, os.path.join(WORK, "export"))

# %% [markdown]
# ## 10. Training curve (for the report)

# %%
try:
    import matplotlib.pyplot as plt

    if history:
        plt.figure(figsize=(6, 3.5))
        plt.plot([h["step"] for h in history], [h["val_loss"] for h in history], marker="o", label="validation")
        plt.plot([h["step"] for h in history], [h["train_loss"] for h in history], marker=".", label="train (last batch)")
        plt.xlabel("step")
        plt.ylabel("cross-entropy")
        plt.legend()
        plt.title("MoodComposer Transformer training")
        plt.tight_layout()
        plt.savefig(os.path.join(WORK, "training_curve.png"), dpi=150)
        plt.show()
except ImportError:
    pass
