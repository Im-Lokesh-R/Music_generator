import { useEffect, useRef, useState } from 'react';
import { INSTRUMENTS } from '../engine/instruments.js';
import { chordName } from '../engine/theory.js';

const LANE_TOP = 38; // sections + chords
const DRUM_H = 46;
const ENERGY_H = 28;

export default function PianoRoll({ song, audioRef, muted }) {
  const canvas = useRef(null);
  const base = useRef(null);
  const wrap = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [song]);

  // draw the static picture once per song
  useEffect(() => {
    if (!song || !width) return;
    const cv = canvas.current;
    const dpr = window.devicePixelRatio || 1;
    const w = width;
    const h = 360;
    cv.width = w * dpr;
    cv.height = h * dpr;
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const off = document.createElement('canvas');
    off.width = cv.width;
    off.height = cv.height;
    const g = off.getContext('2d');
    g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const col = (v) => css.getPropertyValue(v).trim();
    g.fillStyle = col('--roll-bg');
    g.fillRect(0, 0, w, h);

    const { plan, tracks } = song;
    const steps = plan.bars * 16;
    const x = (s) => (s / steps) * w;
    const pitched = tracks.filter((t) => t.name !== 'drums').flatMap((t) => t.notes);
    let lo = 127;
    let hi = 0;
    pitched.forEach((n) => {
      lo = Math.min(lo, n.pitch);
      hi = Math.max(hi, n.pitch);
    });
    if (lo > hi) {
      lo = 48;
      hi = 84;
    }
    lo -= 2;
    hi += 2;
    const rollTop = LANE_TOP;
    const rollH = h - LANE_TOP - DRUM_H - ENERGY_H;
    const y = (p) => rollTop + (1 - (p - lo) / (hi - lo)) * rollH;
    const noteH = Math.max(2, rollH / (hi - lo) - 0.5);

    // section bands + labels
    plan.sections.forEach((s, i) => {
      g.fillStyle = i % 2 ? col('--roll-band') : 'transparent';
      g.fillRect(x(s.start * 16), 0, x((s.end - s.start) * 16), h);
      g.fillStyle = col('--muted');
      g.font = '600 11px Inter, system-ui, sans-serif';
      g.fillText(s.name.toUpperCase(), x(s.start * 16) + 4, 13);
    });
    // bar lines + chord names
    g.font = '11px Inter, system-ui, sans-serif';
    for (let b = 0; b < plan.bars; b++) {
      g.strokeStyle = col('--roll-grid');
      g.lineWidth = b % 4 === 0 ? 1 : 0.4;
      g.beginPath();
      g.moveTo(x(b * 16), 18);
      g.lineTo(x(b * 16), h);
      g.stroke();
      if (b === 0 || chordName(plan.chords[b]) !== chordName(plan.chords[b - 1])) {
        g.fillStyle = col('--text');
        if (x(16) > 22 || b % 2 === 0) g.fillText(chordName(plan.chords[b]), x(b * 16) + 3, 31);
      }
    }
    // octave guide lines
    for (let p = Math.ceil(lo / 12) * 12; p <= hi; p += 12) {
      g.strokeStyle = col('--roll-grid');
      g.lineWidth = 0.5;
      g.beginPath();
      g.moveTo(0, y(p));
      g.lineTo(w, y(p));
      g.stroke();
      g.fillStyle = col('--muted');
      g.fillText(`C${p / 12 - 1}`, 2, y(p) - 2);
    }
    // notes
    for (const t of tracks) {
      const c = INSTRUMENTS[t.name].color;
      g.globalAlpha = muted?.[t.name] ? 0.15 : 0.9;
      if (t.name === 'drums') {
        const dTop = h - DRUM_H - ENERGY_H + 4;
        g.fillStyle = c;
        for (const n of t.notes) {
          const row = { 36: 0, 35: 0, 38: 1, 40: 1, 39: 1, 37: 1 }[n.pitch] ?? 2;
          g.globalAlpha = (muted?.drums ? 0.15 : 0.35) + 0.6 * (n.vel / 127);
          g.fillRect(x(n.start), dTop + row * 13, Math.max(1.5, x(1) * 0.6), 10);
        }
        continue;
      }
      g.fillStyle = c;
      for (const n of t.notes) g.fillRect(x(n.start), y(n.pitch) - noteH / 2, Math.max(1.5, x(n.dur) - 0.5), noteH);
    }
    g.globalAlpha = 1;
    g.fillStyle = col('--muted');
    g.fillText('DRUMS', 2, h - DRUM_H - ENERGY_H + 2);
    // energy curve lane
    const eTop = h - ENERGY_H;
    g.strokeStyle = col('--accent');
    g.lineWidth = 2;
    g.beginPath();
    plan.energy.forEach((e, b) => {
      const px = x(b * 16 + 8);
      const py = eTop + (1 - e) * (ENERGY_H - 6) + 3;
      b ? g.lineTo(px, py) : g.moveTo(px, py);
    });
    g.stroke();
    g.fillStyle = col('--muted');
    g.fillText('ENERGY', 2, eTop + 10);
    base.current = off;
    cv.getContext('2d').drawImage(off, 0, 0);
  }, [song, muted, width]);

  // animated playhead
  useEffect(() => {
    if (!song) return;
    let raf;
    const tick = () => {
      const cv = canvas.current;
      const a = audioRef.current;
      if (cv && base.current) {
        const g = cv.getContext('2d');
        g.drawImage(base.current, 0, 0);
        if (a && a.currentTime > 0) {
          const frac = (a.currentTime - 0.05) / song.plan.seconds;
          const px = frac * cv.width;
          g.fillStyle = 'rgba(255,255,255,0.85)';
          g.fillRect(px, 0, 2 * (window.devicePixelRatio || 1), cv.height);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [song, audioRef]);

  const seek = (e) => {
    const a = audioRef.current;
    if (!a || !song) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - r.left) / r.width) * song.plan.seconds + 0.05;
    a.play();
  };

  if (!song) return <div className="roll-empty">Your composition will appear here as a piano roll.</div>;
  return (
    <div className="roll-wrap" ref={wrap}>
      <canvas ref={canvas} onClick={seek} title="Click to play from here" />
    </div>
  );
}
