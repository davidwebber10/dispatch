import { useEffect, useRef } from 'react';

/**
 * Falling monospace glyph columns, drawn behind the update modal while the daemon rebuilds
 * itself. It is decoration, but honest decoration: the thing you are waiting on really is a
 * terminal doing work.
 *
 * The cursor interacts with the rain: a lead glyph the pointer touches POPS — a small burst
 * of fading sparks — and its column restarts from the top. Pointer position arrives via a
 * window listener (the modal wrapper and glass card sit over the canvas, so the canvas itself
 * never receives pointer events), mapped into canvas space each frame.
 *
 * Mounted ONLY while an update is in flight (see UpdateModal), so there is never an idle
 * canvas animating in the background.
 */

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<>[]{}/\\|=+*#$%&_~^';
const FONT_PX = 13;
const COLUMN_GAP = FONT_PX + 5;
/**
 * Each frame paints the whole canvas with this much near-black instead of clearing it.
 * That is what leaves a fading trail behind every glyph — and, over a second or so, what
 * turns the canvas into an opaque ground for the takeover.
 */
const TRAIL_FADE = 'rgba(8,8,10,0.09)';
/** Cap the backing store: a 3x retina canvas costs real memory for no visible gain. */
const MAX_DPR = 2;
/** How close (px) the pointer must be to a column's lead glyph to pop it. */
const POP_RADIUS = 26;
/** Sparks per pop; bounded overall so a fast swipe across every column stays cheap. */
const SPARKS_PER_POP = 7;
const MAX_SPARKS = 280;

interface Column {
  x: number;
  y: number;
  speed: number;
  seed: number;
  hot: boolean;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // 1 → 0
}

function makeColumns(width: number, height: number): Column[] {
  const cols: Column[] = [];
  for (let x = 2; x < width; x += COLUMN_GAP) {
    cols.push({
      x,
      y: -Math.random() * height,
      speed: 0.9 + Math.random() * 2.4,
      seed: Math.floor(Math.random() * 97),
      hot: Math.random() < 0.28,
    });
  }
  return cols;
}

function spawnBurst(sparks: Spark[], x: number, y: number): void {
  for (let i = 0; i < SPARKS_PER_POP && sparks.length < MAX_SPARKS; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.8 + Math.random() * 2.6;
    sparks.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 0.6, life: 1 });
  }
}

function paint(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cols: Column[],
  sparks: Spark[],
  pointer: { x: number; y: number } | null,
): void {
  ctx.fillStyle = TRAIL_FADE;
  ctx.fillRect(0, 0, w, h);
  ctx.font = `${FONT_PX}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = 'top';

  for (const col of cols) {
    col.y += col.speed;
    if (col.y > h + FONT_PX * 2) {
      col.y = -FONT_PX * (2 + Math.random() * 12);
      col.speed = 0.9 + Math.random() * 2.4;
    }
    // Pointer contact with the lead glyph pops the drop: burst of sparks, column restarts.
    if (
      pointer &&
      Math.abs(col.x + FONT_PX / 2 - pointer.x) < POP_RADIUS &&
      Math.abs(col.y + FONT_PX / 2 - pointer.y) < POP_RADIUS
    ) {
      spawnBurst(sparks, col.x + FONT_PX / 2, col.y + FONT_PX / 2);
      col.y = -FONT_PX * (2 + Math.random() * 12);
      col.speed = 0.9 + Math.random() * 2.4;
      continue;
    }
    const row = Math.floor(col.y / FONT_PX);
    // The leading glyph is bright; the trail behind it is whatever the fade has not
    // yet eaten, so only one extra dim glyph needs drawing.
    ctx.fillStyle = col.hot ? 'rgba(140,255,180,0.95)' : 'rgba(62,207,106,0.62)';
    ctx.fillText(GLYPHS[(row + col.seed) % GLYPHS.length], col.x, col.y);
    ctx.fillStyle = 'rgba(62,207,106,0.18)';
    ctx.fillText(GLYPHS[(col.seed * 7 + row + 3) % GLYPHS.length], col.x, col.y - FONT_PX);
  }

  // Sparks: tiny bright squares flying out of a pop, slowed by drag, gone in ~25 frames.
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.x += s.vx;
    s.y += s.vy;
    s.vx *= 0.96;
    s.vy = s.vy * 0.96 + 0.05; // slight gravity so a burst falls like spray, not a ring
    s.life -= 0.04;
    if (s.life <= 0) {
      sparks.splice(i, 1);
      continue;
    }
    ctx.fillStyle = `rgba(140,255,180,${(s.life * 0.9).toFixed(3)})`;
    const size = 1.5 + s.life * 1.5;
    ctx.fillRect(s.x - size / 2, s.y - size / 2, size, size);
  }
}

export function TerminalRain() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // jsdom (and any locked-down canvas) hands back null. Decoration must never throw.
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let cols: Column[] = [];
    const sparks: Spark[] = [];
    let pointer: { x: number; y: number } | null = null;
    let w = 0;
    let h = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const rect = canvas.getBoundingClientRect();
      w = Math.max(1, Math.floor(rect.width));
      h = Math.max(1, Math.floor(rect.height));
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = makeColumns(w, h);
      ctx.clearRect(0, 0, w, h);
    };
    resize();

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onPointerLeave = () => { pointer = null; };

    // Reduced motion: draw one settled frame and stop. Still atmospheric, never animated —
    // and never interactive, so no pointer listeners either.
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
    if (reduced) {
      for (let i = 0; i < 40; i++) paint(ctx, w, h, cols, sparks, null);
      return () => observer?.disconnect();
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerout', onPointerLeave);

    let raf = 0;
    const frame = () => {
      paint(ctx, w, h, cols, sparks, pointer);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerout', onPointerLeave);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
    />
  );
}
