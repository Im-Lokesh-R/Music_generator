import { INSTRUMENTS } from '../engine/instruments.js';
import Slider from './Slider.jsx';

const REG = { '-2': 'very low', '-1': 'low', 0: 'normal', 1: 'high', 2: 'very high' };

export default function InstrumentCard({ name, controls, onChange, track, muted, solo, onMute, onSolo, onRegenerate, busy }) {
  const inst = INSTRUMENTS[name];
  const set = (k) => (v) => onChange({ ...controls, [k]: v });
  return (
    <div className={`inst-card ${controls.enabled ? '' : 'off'}`} style={{ '--inst': inst.color }}>
      <div className="inst-head">
        <label className="toggle">
          <input type="checkbox" checked={controls.enabled} onChange={(e) => set('enabled')(e.target.checked)} />
          <span className="inst-icon">{inst.icon}</span>
          <span className="inst-name">{inst.label}</span>
        </label>
        {track && (
          <span className="inst-meta" title="role in the arrangement · engine used">
            {track.role} · {track.engine === 'ai' ? 'AI' : 'theory'} · {track.notes.length} notes
          </span>
        )}
      </div>
      {controls.enabled && (
        <>
          <div className="inst-group-title">Composition <span>(regenerate to apply)</span></div>
          <Slider label="Pitch range" value={controls.register} min={-2} max={2} step={1} onChange={set('register')} format={(v) => REG[v]} title="Octave shift — the 'frequency' of this instrument" />
          <Slider label="Density" value={controls.density} onChange={set('density')} title="How many notes it plays" />
          <Slider label="Dynamics" value={controls.velocity} onChange={set('velocity')} title="How hard notes are played (velocity)" />
          <Slider label="Follow rise/drop" value={controls.energyFollow} onChange={set('energyFollow')} title="How strongly the instrument follows the energy curve" />
          <div className="inst-group-title">Mix <span>(live)</span></div>
          <Slider label="Volume" value={controls.volume} onChange={set('volume')} />
          <Slider label="Tone" value={controls.brightness} onChange={set('brightness')} format={(v) => (v < 0.35 ? 'dark' : v > 0.7 ? 'bright' : 'warm')} title="Low-pass filter: dark ↔ bright" />
          <Slider label="Reverb" value={controls.reverb} onChange={set('reverb')} />
          <Slider label="Pan" value={controls.pan} min={-1} max={1} onChange={set('pan')} format={(v) => (Math.abs(v) < 0.05 ? 'center' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)} />
          {track && (
            <div className="inst-actions">
              <button className={`mini ${muted ? 'active' : ''}`} onClick={onMute}>Mute</button>
              <button className={`mini ${solo ? 'active' : ''}`} onClick={onSolo}>Solo</button>
              <button className="mini" disabled={busy} onClick={onRegenerate} title="Compose a new part for this instrument only, keeping the others">↻ New part</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
