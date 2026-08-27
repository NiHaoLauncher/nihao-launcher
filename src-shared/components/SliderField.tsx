import { useEffect, useRef, useState } from "react";
import "./SliderField.css";

/**
 * Draggable slider with a floating value badge and tick marks — the same control used by
 * the launcher's own Game settings (RAM allocation), shared so every RAM-style slider in the
 * app (including per-instance modpack settings) looks and behaves identically instead of
 * each place reimplementing a plain native `<input type="range">`.
 */
export default function SliderField({
  value,
  min,
  max,
  step,
  unit,
  marks,
  disabled = false,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  marks?: number[];
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const percentage = ((value - min) / (max - min)) * 100;
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  function calcValue(clientX: number) {
    if (!trackRef.current) return value;
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const newValue = Math.round((ratio * (max - min) + min) / step) * step;
    return Math.max(min, Math.min(max, newValue));
  }

  function handleTrackClick(e: React.MouseEvent<HTMLDivElement>) {
    if (disabled) return;
    onChange(calcValue(e.clientX));
  }

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (disabled) return;
    e.preventDefault();
    setIsDragging(true);
    onChange(calcValue(e.clientX));
  }

  useEffect(() => {
    if (!isDragging || disabled) return;

    function handleMouseMove(e: MouseEvent) {
      onChange(calcValue(e.clientX));
    }

    function handleMouseUp() {
      setIsDragging(false);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging]);

  // Build tick marks: use custom marks or default 5 evenly spaced
  const tickPositions = marks
    ? marks.map(m => ({ value: m, pct: ((m - min) / (max - min)) * 100 }))
    : Array.from({ length: 5 }).map((_, i) => {
        const v = min + (i / 4) * (max - min);
        return { value: v, pct: (i / 4) * 100 };
      });

  return (
    <div className={`slider-field${disabled ? " slider-field-disabled" : ""}`}>
      <div className="slider-track-wrapper">
        {/* Track */}
        <div
          ref={trackRef}
          className="slider-track"
          onClick={handleTrackClick}
        >
          {/* Green fill */}
          <div
            className="slider-fill"
            style={{ width: `${percentage}%` }}
          />

          {/* Tick marks */}
          {tickPositions.map((t, i) => (
            <div
              key={i}
              className="slider-tick"
              style={{ left: `${t.pct}%` }}
            />
          ))}

          {/* Thumb (draggable) */}
          <div
            className="slider-thumb"
            style={{ left: `${percentage}%` }}
            onMouseDown={handleMouseDown}
          />

          {/* Value badge, floating above the thumb — clamped so it can't overflow the track's edges */}
          <div
            className="slider-value-badge"
            style={{ left: `clamp(28px, ${percentage}%, calc(100% - 28px))` }}
          >
            {value}{unit ? ` ${unit}` : ""}
          </div>
        </div>

        {/* Min / Max labels */}
        <div className="slider-limits">
          <span>{min}</span>
          <span>{max}</span>
        </div>
      </div>
    </div>
  );
}
