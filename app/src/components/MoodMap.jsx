import { MOODS } from '../engine/moods.js';

// Valence (sad ↔ happy) × Arousal (calm ↔ energetic) map — Russell's circumplex model of emotion.
export default function MoodMap({ valence, arousal, estimate }) {
  const S = 200;
  const px = (v) => ((v + 1) / 2) * S;
  const py = (a) => ((1 - a) / 2) * S;
  return (
    <svg viewBox={`-30 -14 ${S + 60} ${S + 30}`} className="moodmap">
      <rect x="0" y="0" width={S} height={S} rx="10" className="mm-bg" />
      <line x1={S / 2} x2={S / 2} y1="0" y2={S} className="grid" />
      <line y1={S / 2} y2={S / 2} x1="0" x2={S} className="grid" />
      {Object.entries(MOODS).map(([k, m]) => (
        <text key={k} x={px(m.valence)} y={py(m.arousal)} className="mm-label" textAnchor="middle">
          {m.emoji}
          <tspan x={px(m.valence)} dy="10">{m.label}</tspan>
        </text>
      ))}
      {estimate && (
        <g>
          <circle cx={px(estimate.v)} cy={py(estimate.a)} r="6" className="mm-est" />
          <line x1={px(valence)} y1={py(arousal)} x2={px(estimate.v)} y2={py(estimate.a)} className="mm-link" />
        </g>
      )}
      <circle cx={px(valence)} cy={py(arousal)} r="8" className="mm-dot" />
      <text x={S / 2} y={-4} textAnchor="middle" className="axis-label">energetic</text>
      <text x={S / 2} y={S + 12} textAnchor="middle" className="axis-label">calm</text>
      <text x={-4} y={S / 2} textAnchor="end" className="axis-label">sad</text>
      <text x={S + 4} y={S / 2} className="axis-label">happy</text>
    </svg>
  );
}
