import { ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const SHOW_DELAY_MS = 1000;

/** Wraps an option (`demo` = a live React preview shown above the text); hovering it for a second pops a hint (text and/or a looping muted clip) below it. */
export default function HoverHint({ text, demo, children }: { text: string; demo?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const hide = () => { clearTimeout(timer.current); setPos(null); };
  const show = () => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setPos({ left: Math.min(r.left, window.innerWidth - 320), top: r.bottom + 8 });
    }, SHOW_DELAY_MS);
  };
  useEffect(() => hide, []);

  return (
    <div ref={ref} onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide}>
      {children}
      {pos && createPortal(
        <div className="hover-hint" style={{ left: Math.max(8, pos.left), top: pos.top }} role="tooltip">
          {demo}
          <p>{text}</p>
        </div>,
        document.body,
      )}
    </div>
  );
}
