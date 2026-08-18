import { useEffect, useRef } from 'react';

/**
 * Celebration fireworks: repeated shell bursts on a full-viewport canvas, using
 * the same tiny-square spark language as TerminalRain's pops so the reward
 * visually rhymes with the game that earned it. Runs for as long as it is
 * mounted (HighScoreCelebration unmounts it with the popup). Decoration
 * contract matches TerminalRain: null 2d context is a silent no-op, and
 * prefers-reduced-motion renders nothing at all.
 */

const MAX_SPARKS = 900;
const BURST_EVERY_MS = 520;
const PALETTE = [
  '140,255,180', // rain green — the house color
  '62,207,106',
  '255,214,102', // gold
  '255,255,255',
  '122,197,255', // sky blue
];

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // 1 → 0
  color: string;
}

function spawnShell(sparks: Spark[], w: number, h: number): void {
  const cx = w * (0.12 + Math.random() * 0.76);
  const cy = h * (0.12 + Math.random() * 0.45);
  const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const count = 42 + Math.floor(Math.random() * 22);
  for (let i = 0; i < count && sparks.length < MAX_SPARKS; i++) {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.2;
    const speed = 1.2 + Math.random() * 3.4;
    sparks.push({ x: cx, y: cy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, color });
  }
}

export function Fireworks() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;

    let w = 0;
    let h = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      w = Math.max(1, Math.floor(rect.width));
      h = Math.max(1, Math.floor(rect.height));
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);

    const sparks: Spark[] = [];
    spawnShell(sparks, w, h); // first shell immediately — no dead first half-second
    const shellTimer = setInterval(() => spawnShell(sparks, w, h), BURST_EVERY_MS);

    let raf = 0;
    const frame = () => {
      ctx.clearRect(0, 0, w, h);
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.x += s.vx;
        s.y += s.vy;
        s.vx *= 0.975;
        s.vy = s.vy * 0.975 + 0.045; // gravity: shells bloom then rain down
        s.life -= 0.012;
        if (s.life <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        // Late-life flicker reads as embers burning out.
        const alpha = s.life * (s.life < 0.35 && Math.random() < 0.35 ? 0.4 : 0.95);
        ctx.fillStyle = `rgba(${s.color},${alpha.toFixed(3)})`;
        const size = 1.5 + s.life * 2;
        ctx.fillRect(s.x - size / 2, s.y - size / 2, size, size);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(shellTimer);
      observer?.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }}
    />
  );
}
