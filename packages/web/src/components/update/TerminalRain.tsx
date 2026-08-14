import { useEffect, useRef } from 'react';

/**
 * Falling monospace glyph columns, drawn behind the update modal while the daemon rebuilds
 * itself. It is decoration, but honest decoration: the thing you are waiting on really is a
 * terminal doing work.
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

interface Column {
  x: number;
  y: number;
  speed: number;
  seed: number;
  hot: boolean;
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

function paint(ctx: CanvasRenderingContext2D, w: number, h: number, cols: Column[]): void {
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
    const row = Math.floor(col.y / FONT_PX);
    // The leading glyph is bright; the trail behind it is whatever the fade has not
    // yet eaten, so only one extra dim glyph needs drawing.
    ctx.fillStyle = col.hot ? 'rgba(140,255,180,0.95)' : 'rgba(62,207,106,0.62)';
    ctx.fillText(GLYPHS[(row + col.seed) % GLYPHS.length], col.x, col.y);
    ctx.fillStyle = 'rgba(62,207,106,0.18)';
    ctx.fillText(GLYPHS[(col.seed * 7 + row + 3) % GLYPHS.length], col.x, col.y - FONT_PX);
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

    // Reduced motion: draw one settled frame and stop. Still atmospheric, never animated.
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
    if (reduced) {
      for (let i = 0; i < 40; i++) paint(ctx, w, h, cols);
      return () => observer?.disconnect();
    }

    let raf = 0;
    const frame = () => {
      paint(ctx, w, h, cols);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
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
