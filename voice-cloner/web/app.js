const $ = (s) => document.querySelector(s);
const MAX_RECORD = 60;
const SCRIPTS = [
  "The quick brown fox jumps over the lazy dog. I like to start my mornings with a cup of coffee and a short walk, because it helps me think clearly before the day gets busy.",
  "Last summer I travelled to the mountains with a few friends. We hiked for hours, watched the sunset from the top, and talked late into the night under a sky full of stars.",
  "Technology changes quickly, but good ideas stay simple. When I build something new, I try to make it easy to understand, pleasant to use, and reliable every single time.",
  "Every evening the city slowly goes quiet. The shops close their shutters, the streetlights come on one by one, and the smell of food drifts from the little stalls on the corner.",
];
const COLORS = ["#7c6cff", "#ff6c9a", "#3ddc97", "#ffb547", "#4cc3ff", "#b46cff", "#ff8a4c"];

const state = {
  status: null,
  voices: [],
  gens: [],
  selected: localStorage.getItem("vc.voice") || null,
  pendingBlob: null,
  pendingName: "",
  scriptIdx: Math.floor(Math.random() * SCRIPTS.length),
  generating: false,
};

// ---------------- api ----------------
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = "toast"), isError ? 6000 : 3000);
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const colorFor = (id) => COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

// ---------------- status ----------------
async function pollStatus() {
  try {
    state.status = await api("/api/status");
    const s = state.status;
    const el = $("#status");
    el.className = `status status-${s.state === "ready" ? "ready" : s.state === "error" ? "error" : "loading"}`;
    const where = s.gpu ? `GPU · ${s.gpu}` : "CPU";
    $("#status-text").textContent =
      s.state === "ready" ? `Model ready · ${where}` :
      s.state === "error" ? "Model failed to load" :
      "Loading XTTS-v2 model… (first run downloads ~1.8 GB)";
    el.title = s.error || "";
    if (!$("#language").options.length) {
      $("#language").innerHTML = Object.entries(s.languages)
        .map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
      $("#language").value = localStorage.getItem("vc.lang") || "en";
    }
    if (s.state === "error") toast(s.error, true);
    else if (s.state !== "ready") setTimeout(pollStatus, 2000);
  } catch {
    $("#status-text").textContent = "Server offline";
    $("#status").className = "status status-error";
    setTimeout(pollStatus, 3000);
  }
  updateGenerateButton();
}

// ---------------- voices ----------------
async function loadVoices() {
  state.voices = await api("/api/voices");
  if (!state.voices.find((v) => v.id === state.selected)) state.selected = state.voices[0]?.id || null;
  renderVoices();
}

function renderVoices() {
  $("#voice-count").textContent = state.voices.length;
  const box = $("#voices");
  if (!state.voices.length) {
    box.innerHTML = `<div class="empty-note">No voices yet. Record or upload one above.</div>`;
  } else {
    box.innerHTML = state.voices.map((v) => `
      <div class="voice ${v.id === state.selected ? "selected" : ""}" data-id="${v.id}">
        <div class="avatar" style="background:${colorFor(v.id)}">${esc(v.name.trim()[0] || "?").toUpperCase()}</div>
        <div class="voice-info">
          <div class="voice-name">${esc(v.name)}</div>
          <div class="voice-meta">${v.duration}s sample · ${new Date(v.created * 1000).toLocaleDateString()}</div>
        </div>
        <button class="icon-btn" data-act="play" title="Play original sample">▶</button>
        <button class="icon-btn" data-act="rename" title="Rename">✎</button>
        <button class="icon-btn danger" data-act="delete" title="Delete">🗑</button>
      </div>`).join("");
  }
  const sel = state.voices.find((v) => v.id === state.selected);
  $("#selected-voice-name").textContent = sel ? sel.name : "select a voice";
  if (state.selected) localStorage.setItem("vc.voice", state.selected);
  updateGenerateButton();
}

const sampleAudio = new Audio();
$("#voices").addEventListener("click", async (e) => {
  const card = e.target.closest(".voice");
  if (!card) return;
  const id = card.dataset.id;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "play") {
    const btn = e.target.closest("button");
    if (!sampleAudio.paused && sampleAudio.dataset.id === id) {
      sampleAudio.pause();
      return;
    }
    document.querySelectorAll('[data-act="play"]').forEach((b) => (b.textContent = "▶"));
    sampleAudio.src = `/api/voices/${id}/audio`;
    sampleAudio.dataset.id = id;
    sampleAudio.play();
    btn.textContent = "❚❚";
    sampleAudio.onpause = sampleAudio.onended = () => (btn.textContent = "▶");
  } else if (act === "rename") {
    const v = state.voices.find((x) => x.id === id);
    const name = prompt("Rename voice", v.name);
    if (!name) return;
    const fd = new FormData();
    fd.append("name", name);
    await api(`/api/voices/${id}`, { method: "PATCH", body: fd });
    loadVoices();
  } else if (act === "delete") {
    const v = state.voices.find((x) => x.id === id);
    if (!confirm(`Delete the voice "${v.name}"?`)) return;
    await api(`/api/voices/${id}`, { method: "DELETE" });
    toast("Voice deleted");
    loadVoices();
  } else {
    state.selected = id;
    renderVoices();
  }
});

// ---------------- tabs ----------------
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    $("#tab-record").classList.toggle("hidden", t.dataset.tab !== "record");
    $("#tab-upload").classList.toggle("hidden", t.dataset.tab !== "upload");
  })
);

// ---------------- recording ----------------
function showScript() { $("#script-text").textContent = SCRIPTS[state.scriptIdx]; }
$("#next-script").onclick = () => { state.scriptIdx = (state.scriptIdx + 1) % SCRIPTS.length; showScript(); };

const wave = $("#wave");
const wctx = wave.getContext("2d");
let rec = null;

function sizeCanvas(c) {
  const r = c.getBoundingClientRect();
  c.width = r.width * devicePixelRatio;
  c.height = r.height * devicePixelRatio;
}

function drawIdleWave() {
  sizeCanvas(wave);
  wctx.clearRect(0, 0, wave.width, wave.height);
  wctx.fillStyle = "#262a35";
  wctx.fillRect(0, wave.height / 2 - 1, wave.width, 2);
}

async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    toast("Microphone access was blocked: " + err.message, true);
    return;
  }
  const ac = new AudioContext();
  const analyser = ac.createAnalyser();
  analyser.fftSize = 2048;
  ac.createMediaStreamSource(stream).connect(analyser);
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    ac.close();
    const secs = (performance.now() - rec.t0) / 1000;
    const blob = new Blob(chunks, { type: recorder.mimeType });
    rec = null;
    $("#rec-btn").classList.remove("recording");
    if (secs < (state.status?.min_seconds ?? 10)) {
      toast(`That was only ${secs.toFixed(1)}s. Please record at least 10 seconds.`, true);
      $("#rec-hint").textContent = "Too short. Try again and read the whole text.";
      return;
    }
    $("#rec-hint").textContent = "Done! Listen back, give it a name and clone it below.";
    setPending(blob, "My voice", `Recorded ${secs.toFixed(1)}s`);
  };
  recorder.start(250);
  rec = { recorder, analyser, t0: performance.now(), history: [] };
  $("#rec-btn").classList.add("recording");
  $("#rec-hint").textContent = "Recording… read the text naturally, then press stop.";
  sizeCanvas(wave);
  recLoop();
}

function recLoop() {
  if (!rec) return;
  const secs = (performance.now() - rec.t0) / 1000;
  $("#rec-time").textContent = secs.toFixed(1);
  const bar = $("#rec-progress");
  bar.style.width = Math.min(100, (secs / MAX_RECORD) * 100) + "%";
  bar.classList.toggle("ok", secs >= 10);
  if (secs >= 10 && secs < 10.2) $("#rec-hint").textContent = "10s reached ✓ More (20–30s) gives a better clone.";

  const buf = new Float32Array(rec.analyser.fftSize);
  rec.analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  for (const x of buf) peak = Math.max(peak, Math.abs(x));
  rec.history.push(peak);

  const W = wave.width, H = wave.height, step = 4 * devicePixelRatio;
  const n = Math.floor(W / step);
  const hist = rec.history.slice(-n);
  wctx.clearRect(0, 0, W, H);
  hist.forEach((p, i) => {
    const h = Math.max(2, Math.min(1, p * 1.6) * H * 0.9);
    wctx.fillStyle = p > 0.95 ? "#ff5d6c" : "#7c6cff";
    wctx.fillRect(i * step, (H - h) / 2, step - devicePixelRatio, h);
  });

  if (secs >= MAX_RECORD) rec.recorder.stop();
  else requestAnimationFrame(recLoop);
}

$("#rec-btn").onclick = () => {
  if (rec) rec.recorder.stop();
  else startRecording();
};

// ---------------- upload ----------------
const drop = $("#drop");
$("#file-input").onchange = (e) => e.target.files[0] && handleFile(e.target.files[0]);
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]));

async function handleFile(file) {
  let info = `${file.name} · ${(file.size / 1e6).toFixed(1)} MB`;
  try {
    const ac = new AudioContext();
    const buf = await ac.decodeAudioData(await file.arrayBuffer());
    ac.close();
    info += ` · ${buf.duration.toFixed(1)}s`;
    if (buf.duration < 10) toast(`This file is ${buf.duration.toFixed(1)}s. At least 10s of speech is needed.`, true);
  } catch {}
  setPending(file, file.name.replace(/\.[^.]+$/, ""), info);
}

// ---------------- pending sample -> clone ----------------
function setPending(blob, name, info) {
  state.pendingBlob = blob;
  $("#pending-audio").src = URL.createObjectURL(blob);
  $("#voice-name").value = name;
  $("#pending-info").textContent = info;
  $("#pending").classList.remove("hidden");
  $("#voice-name").focus();
  $("#voice-name").select();
}

function clearPending() {
  state.pendingBlob = null;
  $("#pending").classList.add("hidden");
  $("#pending-audio").removeAttribute("src");
  $("#file-input").value = "";
}

$("#discard").onclick = clearPending;
$("#voice-name").addEventListener("keydown", (e) => e.key === "Enter" && $("#save-voice").click());

$("#save-voice").onclick = async () => {
  if (!state.pendingBlob) return;
  const btn = $("#save-voice");
  btn.disabled = true;
  btn.textContent = "Cloning…";
  const fd = new FormData();
  const ext = state.pendingBlob.name?.split(".").pop() || (state.pendingBlob.type.includes("ogg") ? "ogg" : "webm");
  fd.append("name", $("#voice-name").value || "Untitled voice");
  fd.append("file", state.pendingBlob, state.pendingBlob.name || `recording.${ext}`);
  try {
    const v = await api("/api/voices", { method: "POST", body: fd });
    state.selected = v.id;
    clearPending();
    await loadVoices();
    toast(`Voice "${v.name}" cloned (${v.duration}s of speech)`);
    $("#text").focus();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Clone voice";
  }
};

// ---------------- generation ----------------
const text = $("#text");
text.value = localStorage.getItem("vc.text") || "";
const updateChar = () => ($("#char").textContent = `${text.value.length} / 2000`);
text.addEventListener("input", () => { updateChar(); updateGenerateButton(); localStorage.setItem("vc.text", text.value); });
updateChar();

const speed = $("#speed"), temp = $("#temperature");
speed.oninput = () => ($("#speed-out").textContent = (+speed.value).toFixed(2) + "×");
temp.oninput = () => ($("#temp-out").textContent = (+temp.value).toFixed(2));
$("#language").onchange = (e) => localStorage.setItem("vc.lang", e.target.value);

function updateGenerateButton() {
  const ready = state.status?.state === "ready";
  const ok = ready && state.selected && text.value.trim() && !state.generating;
  $("#generate").disabled = !ok;
  if (state.generating) return;
  $("#gen-hint").textContent =
    !ready ? "Waiting for the model to load…" :
    !state.selected ? "Clone or select a voice first." :
    !text.value.trim() ? "Type some text to speak." : "";
}

async function generate() {
  if ($("#generate").disabled) return;
  state.generating = true;
  const btn = $("#generate");
  btn.disabled = true;
  btn.classList.add("loading");
  btn.querySelector(".btn-label").textContent = "Generating…";
  const t0 = performance.now();
  const tick = setInterval(() => ($("#gen-hint").textContent = `Synthesising… ${((performance.now() - t0) / 1000).toFixed(0)}s`), 500);
  try {
    const g = await api("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice_id: state.selected,
        text: text.value,
        language: $("#language").value,
        speed: +speed.value,
        temperature: +temp.value,
      }),
    });
    await loadGens();
    openInPlayer(g, true);
    $("#gen-hint").textContent = `Made ${g.duration}s of audio in ${g.took}s`;
  } catch (err) {
    toast(err.message, true);
    $("#gen-hint").textContent = "";
  } finally {
    clearInterval(tick);
    state.generating = false;
    btn.classList.remove("loading");
    btn.querySelector(".btn-label").textContent = "Generate speech";
    updateGenerateButton();
  }
}
$("#generate").onclick = generate;
document.addEventListener("keydown", (e) => (e.ctrlKey || e.metaKey) && e.key === "Enter" && generate());

// ---------------- player ----------------
const player = new Audio();
let current = null; // { gen, peaks }

async function openInPlayer(gen, autoplay) {
  const url = `/api/generations/${gen.id}/audio`;
  current = { gen, peaks: null };
  player.src = url;
  $("#player").className = "player";
  $("#player").innerHTML = `
    <div class="player-top">
      <button class="play-big" id="pp">▶</button>
      <div class="player-text">
        <div class="quote">“${esc(gen.text)}”</div>
        <div class="meta">${esc(gen.voice_name)} · ${state.status?.languages[gen.language] || gen.language} · ${gen.speed}×</div>
      </div>
      <a class="icon-btn" href="${url}?download=true" title="Download WAV">⬇</a>
    </div>
    <canvas class="scrub" id="scrub"></canvas>
    <div class="times"><span id="t-cur">0:00</span><span id="t-dur">${fmtTime(gen.duration)}</span></div>`;
  $("#pp").onclick = () => (player.paused ? player.play() : player.pause());
  const scrub = $("#scrub");
  scrub.onclick = (e) => {
    const r = scrub.getBoundingClientRect();
    player.currentTime = ((e.clientX - r.left) / r.width) * (player.duration || gen.duration);
    if (player.paused) player.play();
  };
  renderHistory();
  try {
    const ac = new AudioContext();
    const buf = await ac.decodeAudioData(await (await fetch(url)).arrayBuffer());
    ac.close();
    const data = buf.getChannelData(0), N = 160, block = Math.floor(data.length / N);
    current.peaks = Array.from({ length: N }, (_, i) => {
      let m = 0;
      for (let j = i * block; j < (i + 1) * block; j++) m = Math.max(m, Math.abs(data[j]));
      return m;
    });
  } catch {}
  drawScrub();
  if (autoplay) player.play().catch(() => {});
}

function drawScrub() {
  const c = $("#scrub");
  if (!c || !current) return;
  sizeCanvas(c);
  const ctx = c.getContext("2d"), W = c.width, H = c.height;
  const peaks = current.peaks || Array(160).fill(0.05);
  const prog = player.duration ? player.currentTime / player.duration : 0;
  const bw = W / peaks.length;
  ctx.clearRect(0, 0, W, H);
  peaks.forEach((p, i) => {
    const h = Math.max(2 * devicePixelRatio, p * H * 0.95);
    ctx.fillStyle = i / peaks.length < prog ? "#9b8cff" : "#363b4a";
    ctx.fillRect(i * bw, (H - h) / 2, Math.max(1, bw - 2 * devicePixelRatio), h);
  });
}

player.ontimeupdate = () => {
  const t = $("#t-cur");
  if (t) t.textContent = fmtTime(player.currentTime);
  drawScrub();
};
player.onplay = () => { $("#pp") && ($("#pp").textContent = "❚❚"); (function f() { drawScrub(); if (!player.paused) requestAnimationFrame(f); })(); };
player.onpause = player.onended = () => { $("#pp") && ($("#pp").textContent = "▶"); drawScrub(); };

// ---------------- history ----------------
async function loadGens() {
  state.gens = await api("/api/generations");
  renderHistory();
}

function renderHistory() {
  $("#gen-count").textContent = state.gens.length;
  const box = $("#history");
  if (!state.gens.length) {
    box.innerHTML = `<div class="empty-note">Nothing generated yet.</div>`;
    return;
  }
  box.innerHTML = state.gens.map((g) => `
    <div class="gen ${current?.gen.id === g.id ? "active" : ""}" data-id="${g.id}">
      <button class="icon-btn" data-act="open" title="Play">▶</button>
      <div class="gen-text">
        <div class="quote">${esc(g.text)}</div>
        <div class="meta">${esc(g.voice_name)} · ${g.duration}s · ${new Date(g.created * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
      </div>
      <a class="icon-btn" href="/api/generations/${g.id}/audio?download=true" title="Download">⬇</a>
      <button class="icon-btn danger" data-act="delete" title="Delete">🗑</button>
    </div>`).join("");
}

$("#history").addEventListener("click", async (e) => {
  const row = e.target.closest(".gen");
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!row || !act) return;
  const g = state.gens.find((x) => x.id === row.dataset.id);
  if (act === "open") openInPlayer(g, true);
  else if (act === "delete") {
    await api(`/api/generations/${g.id}`, { method: "DELETE" });
    if (current?.gen.id === g.id) {
      player.pause();
      current = null;
      $("#player").className = "player empty";
      $("#player").innerHTML = `<div class="player-empty">Generated audio will appear here.</div>`;
    }
    loadGens();
  }
});

window.addEventListener("resize", () => { if (!rec) drawIdleWave(); drawScrub(); });

// ---------------- boot ----------------
showScript();
drawIdleWave();
pollStatus();
loadVoices().catch(() => {});
loadGens().catch(() => {});
