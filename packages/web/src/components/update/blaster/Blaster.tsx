import { useEffect, useRef, useState } from 'react';
import { newGame, step, type Game, type Input, type Rect, type Vec } from './engine';
import { readBest, recordBest } from '../popScore';

/** The time of the last key, mouse or touch input (UpdateModal reloads after a quiet spell once the update is done). */
export const blasterActivity = { last: 0 };

const GREEN = '#3ecf6a';
const PALE = '#d6ffe4';
const AMBER = '#f5c542';
const RED = '#ff6b6b';
const ROCK = '#8fd9a8';
const JOY_RADIUS = 56;

/** Keys that drive the ship; any other key only starts or restarts a round. */
const MOVE_KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0], W: [0, -1], S: [0, 1], A: [-1, 0], D: [1, 0],
};
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** A fixed 8-point outline per asteroid, so a rock keeps its shape from frame to frame. */
function rockShape(seed: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < 8; k++) out.push(0.75 + (((Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1) * 0.35);
  return out;
}

function draw(ctx: CanvasRenderingContext2D, g: Game, wall: Rect | null, joy: { origin: Vec; at: Vec } | null): void {
  const { w, h } = g;
  ctx.fillStyle = '#060908';
  ctx.fillRect(0, 0, w, h);
  // A quiet star field.
  ctx.fillStyle = 'rgba(62,207,106,.22)';
  for (let k = 0; k < 70; k++) ctx.fillRect((k * 137.5) % w, (k * 89.3 + (k % 7) * 31) % h, 1.4, 1.4);
  if (wall) {
    ctx.strokeStyle = 'rgba(62,207,106,.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(wall.x - 3, wall.y - 3, wall.w + 6, wall.h + 6);
  }
  ctx.lineWidth = 1.6;
  for (const e of g.enemies) {
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.beginPath();
    if (e.kind === 'drone') {
      ctx.strokeStyle = GREEN;
      ctx.moveTo(0, -e.r); ctx.lineTo(e.r, 0); ctx.lineTo(0, e.r); ctx.lineTo(-e.r, 0); ctx.closePath();
    } else if (e.kind === 'gunship') {
      ctx.strokeStyle = AMBER;
      for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; ctx[k ? 'lineTo' : 'moveTo'](Math.cos(a) * e.r, Math.sin(a) * e.r); }
      ctx.closePath();
    } else {
      ctx.strokeStyle = ROCK;
      const shape = rockShape(Math.round(e.r * 10 + e.cooldown));
      shape.forEach((m, k) => { const a = (k / 8) * Math.PI * 2; ctx[k ? 'lineTo' : 'moveTo'](Math.cos(a) * e.r * m, Math.sin(a) * e.r * m); });
      ctx.closePath();
    }
    ctx.stroke();
    ctx.restore();
  }
  ctx.strokeStyle = PALE;
  ctx.lineWidth = 2;
  for (const o of g.shots) { ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x - o.vx * 0.012, o.y - o.vy * 0.012); ctx.stroke(); }
  ctx.fillStyle = RED;
  for (const o of g.enemyShots) { ctx.beginPath(); ctx.arc(o.x, o.y, 3, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = 'rgba(214,255,228,.8)';
  ctx.lineWidth = 1.2;
  for (const p of g.particles) { ctx.globalAlpha = Math.min(1, p.life * 2); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke(); }
  ctx.globalAlpha = 1;
  const s = g.ship;
  if (!g.over && (s.shield <= 0 || Math.floor(g.time * 10) % 2 === 0)) {
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.angle);
    ctx.strokeStyle = PALE;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(s.r + 4, 0); ctx.lineTo(-s.r, -s.r * 0.8); ctx.lineTo(-s.r * 0.5, 0); ctx.lineTo(-s.r, s.r * 0.8); ctx.closePath(); ctx.stroke();
    ctx.restore();
  }
  if (g.banner && g.time < g.banner.until) {
    ctx.fillStyle = 'rgba(62,207,106,.85)';
    ctx.font = '600 22px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(g.banner.text, w / 2, Math.max(60, (wall ? wall.y : h / 2) - 30));
  }
  if (joy) {
    ctx.strokeStyle = 'rgba(214,255,228,.25)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(joy.origin.x, joy.origin.y, JOY_RADIUS, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(214,255,228,.3)';
    ctx.beginPath(); ctx.arc(joy.at.x, joy.at.y, 18, 0, Math.PI * 2); ctx.fill();
  }
}

/**
 * The game behind the update window: a top-down blaster. The status card (`getWall`) is a
 * wall. On a desktop the arrow keys or WASD move the ship and point it, and Space shoots;
 * the mouse only starts a round. On a phone one joystick moves and the ship fires on its own.
 * It starts at the first key or tap, and a round never ends the update or the other way round.
 */
export function Blaster({ getWall, paused }: { getWall: () => Rect | null; paused: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const game = useRef<Game | null>(null);
  const [started, setStarted] = useState(false);
  const [hud, setHud] = useState({ score: 0, lives: 3, wave: 1, combo: 0, over: false });
  const [best, setBest] = useState(() => readBest()?.score ?? 0);
  const roundBest = useRef(best);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const input = useRef<Input>({ move: { x: 0, y: 0 }, aim: null, fire: false, autoAim: false });
  const keys = useRef(new Set<string>());
  const joy = useRef<{ id: number; origin: Vec; at: Vec } | null>(null);

  const startRound = () => {
    const c = canvasRef.current;
    const w = c?.clientWidth || window.innerWidth, h = c?.clientHeight || window.innerHeight;
    game.current = newGame(w, h, Math.random, getWall());
    roundBest.current = readBest()?.score ?? 0;
    setStarted(true);
    setHud({ score: 0, lives: 3, wave: 1, combo: 0, over: false });
  };
  const touch = () => { blasterActivity.last = Date.now(); };
  /** The first input starts a round; after a game over, an input starts the next one. */
  const wake = () => {
    touch();
    if (!game.current || game.current.over) { startRound(); return true; }
    return false;
  };

  // Keyboard.
  useEffect(() => {
    const syncMove = () => {
      let x = 0, y = 0;
      for (const k of keys.current) { const m = MOVE_KEYS[k]; if (m) { x += m[0]; y += m[1]; } }
      input.current.move = { x, y };
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (wake()) return;
      if (MOVE_KEYS[e.key] || e.key === ' ') e.preventDefault();
      if (e.key === ' ') input.current.fire = true;
      keys.current.add(e.key);
      input.current.autoAim = false;
      syncMove();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') input.current.fire = false;
      keys.current.delete(e.key);
      syncMove();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  });

  // The frame loop.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastSave = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const c = canvasRef.current;
      if (!c) return;
      const w = c.clientWidth, h = c.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const g = game.current;
      const wall = getWall();
      if (g) {
        g.w = w; g.h = h;
        if (!pausedRef.current && !document.hidden) step(g, dt, input.current, wall);
        if (g.score > roundBest.current && now - lastSave > 1000) { recordBest(g.score, roundBest.current); lastSave = now; setBest(g.score); }
        setHud((prev) => (prev.score === g.score && prev.lives === g.lives && prev.wave === g.wave && prev.combo === g.combo && prev.over === g.over ? prev : { score: g.score, lives: g.lives, wave: g.wave, combo: g.combo, over: g.over }));
      }
      let ctx: CanvasRenderingContext2D | null = null;
      try { ctx = c.getContext('2d'); } catch { ctx = null; }
      if (!ctx) return; // no canvas (tests, odd browsers): the HUD still works
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(ctx, g ?? newGame(w, h, () => 0.5), wall, joy.current);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [getWall]);

  // Save the best score when a round ends.
  useEffect(() => {
    const g = game.current;
    if (hud.over && g && g.score > roundBest.current) { recordBest(g.score, roundBest.current); setBest(g.score); }
  }, [hud.over]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const fresh = wake();
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      input.current.autoAim = true;
      if (!fresh && !joy.current) joy.current = { id: e.pointerId, origin: { x: e.clientX, y: e.clientY }, at: { x: e.clientX, y: e.clientY } };
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ }
    }
    // A mouse click only starts a round: the keys steer, point and shoot.
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse') return;
    const j = joy.current;
    if (!j || j.id !== e.pointerId) return;
    touch();
    const dx = e.clientX - j.origin.x, dy = e.clientY - j.origin.y;
    const d = Math.hypot(dx, dy), k = d > JOY_RADIUS ? JOY_RADIUS / d : 1;
    j.at = { x: j.origin.x + dx * k, y: j.origin.y + dy * k };
    input.current.move = { x: (dx * k) / JOY_RADIUS, y: (dy * k) / JOY_RADIUS };
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse') return;
    if (joy.current?.id === e.pointerId) { joy.current = null; input.current.move = { x: 0, y: 0 }; }
  };

  const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  const label: React.CSSProperties = { fontSize: 10.5, letterSpacing: 2, color: 'rgba(62,207,106,.72)' };
  const value: React.CSSProperties = { fontSize: 22, fontWeight: 700, color: GREEN, lineHeight: 1.1 };
  return (
    <div style={{ position: 'absolute', inset: 0, fontFamily: mono }}>
      <canvas ref={canvasRef} aria-hidden="true" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none', cursor: 'default' }} />
      {started && (
        <>
          <div style={{ position: 'absolute', top: 'max(14px, env(safe-area-inset-top))', left: 16, pointerEvents: 'none' }}>
            <div style={label}>SCORE</div>
            <div style={value}>{hud.score.toLocaleString()}</div>
            {hud.combo > 1 && <div style={{ fontSize: 12, color: AMBER }}>×{hud.combo} combo</div>}
          </div>
          <div style={{ position: 'absolute', top: 'max(14px, env(safe-area-inset-top))', right: 16, textAlign: 'right', pointerEvents: 'none' }}>
            <div style={label}>BEST</div>
            <div style={{ ...value, fontSize: 16 }}>{Math.max(best, hud.score).toLocaleString()}</div>
            <div aria-label={`${hud.lives} lives`} style={{ marginTop: 4, fontSize: 13, color: PALE, letterSpacing: 3 }}>{'▲'.repeat(Math.max(0, hud.lives))}</div>
            <div style={{ fontSize: 10.5, letterSpacing: 2, color: 'rgba(62,207,106,.6)' }}>WAVE {hud.wave}</div>
          </div>
        </>
      )}
      {(!started || hud.over) && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 'max(28px, env(safe-area-inset-bottom))', textAlign: 'center', pointerEvents: 'none', color: 'rgba(214,255,228,.85)', fontSize: 13, letterSpacing: 1 }}>
          {hud.over && <div style={{ fontSize: 18, fontWeight: 700, color: RED, marginBottom: 6 }}>GAME OVER · {hud.score.toLocaleString()}</div>}
          {hud.over ? 'Press any key or tap to play again' : 'Press any key or tap to play'}
          <div style={{ marginTop: 6, fontSize: 11, color: 'rgba(214,255,228,.5)' }}>Arrows or WASD move and point · Space shoots · On a phone, drag to move; it shoots by itself</div>
        </div>
      )}
    </div>
  );
}
