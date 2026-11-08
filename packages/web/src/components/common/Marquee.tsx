import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

// A mask uses alpha only: currentColor is opaque, transparent fades. One gradient whose two fade
// widths are registered custom properties, so a fade grows and shrinks (owner, 2026-11-07: fade in and
// out, do not just appear). A gradient itself cannot be animated; a registered <length> can.
const MASK = 'linear-gradient(to right, transparent 0, currentColor var(--mq-l), currentColor calc(100% - var(--mq-r)), transparent 100%)';
const FADE_PX = 22;
const FADE_MS = 400;
let registered = false;
function registerFadeProps() {
  if (registered || typeof document === 'undefined') return;
  registered = true;
  const el = document.createElement('style');
  el.setAttribute('data-marquee-props', '');
  el.textContent = ['--mq-l', '--mq-r'].map((n) => `@property ${n} { syntax: '<length>'; inherits: false; initial-value: 0px; }`).join('\n');
  document.head.appendChild(el);
}

/**
 * One line of text that fits, or, when it is too long, fades at its cut edge and every few seconds
 * scrolls slowly to its end and back (owner, 2026-11-07: long thread names in the phone header).
 * No ellipsis. Reduce Motion: the fade stays and the text never moves.
 */
export function Marquee({ text, style, delayMs = 3000, pauseMs = 2000, pxPerSecond = 30 }: {
  text: string; style?: CSSProperties; delayMs?: number; pauseMs?: number; pxPerSecond?: number;
}) {
  registerFadeProps();
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
  const left = phase === 'rest' ? 0 : FADE_PX;
  const right = phase === 'end' ? 0 : FADE_PX;
  const fade = hidden ? {
    maskImage: MASK, WebkitMaskImage: MASK, ['--mq-l' as string]: `${left}px`, ['--mq-r' as string]: `${right}px`,
    transition: `--mq-l ${FADE_MS}ms ease, --mq-r ${FADE_MS}ms ease`,
  } as CSSProperties : {};
  return (
    <span ref={boxRef} data-marquee="box" title={hidden ? text : undefined}
      style={{ display: 'block', overflow: 'hidden', whiteSpace: 'nowrap', minWidth: 0, ...fade, ...style }}>
      <span ref={textRef} data-marquee="text"
        onTransitionEnd={(e) => { if (e.target !== e.currentTarget) return; setPhase((p) => (p === 'out' ? 'end' : p === 'back' ? 'rest' : p)); }}
        style={{
          display: 'inline-block', whiteSpace: 'nowrap', willChange: hidden && !reduce ? 'transform' : undefined,
          transform: phase === 'rest' ? undefined : `translateX(${atEnd ? -hidden : 0}px)`,
          transition: moving ? `transform ${ms}ms linear` : undefined,
        }}>{text}</span>
    </span>
  );
}
