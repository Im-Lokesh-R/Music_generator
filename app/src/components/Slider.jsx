export default function Slider({ label, value, min = 0, max = 1, step = 0.01, onChange, format, title }) {
  const shown = format ? format(value) : `${Math.round(((value - min) / (max - min)) * 100)}%`;
  return (
    <label className="slider" title={title}>
      <span className="slider-label">
        {label}
        <span className="slider-value">{shown}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </label>
  );
}
