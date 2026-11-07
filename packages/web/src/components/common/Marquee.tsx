import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

// A mask uses alpha only: currentColor is opaque, transparent fades.
const FADE = 'linear-gradient(to DIR, currentColor calc(100% - 22px), transparent)';

/**
 * One line of text that fits, or, when it is too long, fades at its cut edge and every few seconds
 * scrolls slowly to its end and back (owner, 2026-11-07: long thread names in the phone header).
 * No ellipsis. Reduce Motion: the fade stays and the text never moves.
 */
export function Marquee({ text, style, delayMs = 3000, pauseMs = 2000, pxPerSecond = 30 }: {
  text: string; style?: CSSProperties; delayMs?: number; pauseMs?: number; pxPerSecond?: number;
}) {
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [hidden, setHidden] = useState(0); // px of text past the box
  const [phase, setPhase] = useState<'rest' | 'out' | 'end' | 'back'>('rest');
  const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useLayoutEffect(() => {
    const measure = () => {
      const box = boxRef.current; const t = textRef.current;
      if (!box || !t) return;
      setHidden(Math.max(0, Math.round(t.scrollWidth - box.clientWidth)));
    };
    measure();
    setPhase('rest');
    if (typeof ResizeObserver === 'undefined' || !boxRef.current) return;
    const ro = new ResizeObserver(measure);
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, [text]);

  // rest → (wait) → out → end → (pause) → back → rest …
  useEffect(() => {
    if (!hidden || reduce) return;
    if (phase === 'rest') { const id = setTimeout(() => setPhase('out'), delayMs); return () => clearTimeout(id); }
    if (phase === 'end') { const id = setTimeout(() => setPhase('back'), pauseMs); return () => clearTimeout(id); }
  }, [phase, hidden, reduce, delayMs, pauseMs]);

  const moving = phase === 'out' || phase === 'back';
  const atEnd = phase === 'out' || phase === 'end';
  const ms = Math.round((hidden / pxPerSecond) * 1000);
  // At rest the right edge fades; at the end the left edge fades; while moving, both do.
  const BOTH = 'linear-gradient(to right, transparent, currentColor 22px, currentColor calc(100% - 22px), transparent)';
  const mask = !hidden ? undefined : moving ? BOTH : FADE.replace('DIR', phase === 'end' ? 'left' : 'right');
  return (
    <span ref={boxRef} data-marquee="box" title={hidden ? text : undefined}
      style={{ display: 'block', overflow: 'hidden', whiteSpace: 'nowrap', minWidth: 0, maskImage: mask, WebkitMaskImage: mask, ...style }}>
      <span ref={textRef} data-marquee="text"
        onTransitionEnd={() => setPhase((p) => (p === 'out' ? 'end' : p === 'back' ? 'rest' : p))}
        style={{
          display: 'inline-block', whiteSpace: 'nowrap', willChange: hidden && !reduce ? 'transform' : undefined,
          transform: phase === 'rest' ? undefined : `translateX(${atEnd ? -hidden : 0}px)`,
          transition: moving ? `transform ${ms}ms linear` : undefined,
        }}>{text}</span>
    </span>
  );
}
