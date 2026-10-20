import { useRef } from 'react';
import { ENERGY_LABELS, ENERGY_PRESETS } from '../engine/conductor.js';

const W = 560;
const H = 130;
const PAD = 12;

export default function EnergyEditor({ points, onChange }) {
  const svg = useRef(null);
  const dragging = useRef(false);

  const toXY = (v, i) => [PAD + (i / (points.length - 1)) * (W - 2 * PAD), PAD + (1 - v) * (H - 2 * PAD)];

  const setFromEvent = (e) => {
    const r = svg.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    const i = Math.round(((x - PAD) / (W - 2 * PAD)) * (points.length - 1));
    if (i < 0 || i >= points.length) return;
    const v = Math.max(0, Math.min(1, 1 - (y - PAD) / (H - 2 * PAD)));
    const next = [...points];
    next[i] = Math.round(v * 100) / 100;
    onChange(next);
  };

  const path = points.map((v, i) => toXY(v, i).join(',')).join(' ');
  const area = `${PAD},${H - PAD} ${path} ${W - PAD},${H - PAD}`;

  return (
    <div className="energy">
      <div className="energy-presets">
        {Object.entries(ENERGY_LABELS).map(([k, label]) => (
          <button key={k} className="chip small" onClick={() => onChange([...ENERGY_PRESETS[k]])}>
            {label}
          </button>
        ))}
      </div>
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className="energy-svg"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          setFromEvent(e);
        }}
        onPointerMove={(e) => dragging.current && setFromEvent(e)}
        onPointerUp={() => (dragging.current = false)}
      >
        <defs>
          <linearGradient id="eg" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.03" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={PAD} x2={W - PAD} y1={PAD + (1 - g) * (H - 2 * PAD)} y2={PAD + (1 - g) * (H - 2 * PAD)} className="grid" />
        ))}
        <polygon points={area} fill="url(#eg)" />
        <polyline points={path} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" />
        {points.map((v, i) => {
          const [x, y] = toXY(v, i);
          return <circle key={i} cx={x} cy={y} r="5" className="energy-dot" />;
        })}
        <text x={PAD + 2} y={H - 2} className="axis-label">start</text>
        <text x={W - PAD - 24} y={H - 2} className="axis-label">end</text>
      </svg>
      <div className="hint">Drag to draw how the music rises and drops over time. Low = sparse & soft, high = full & loud.</div>
    </div>
  );
}
