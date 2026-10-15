import { useEffect, useRef, useState } from 'react';
import { COOLDOWN, newGame, step, type Game, type Input, type Rect, type Vec, type Weapon } from './engine';
import { readBest, recordBest } from '../popScore';

/** The time of the last key, mouse or touch input (UpdateModal reloads after a quiet spell once the update is done). */
export const blasterActivity = { last: 0 };

const GREEN = '#3ecf6a';
const PALE = '#d6ffe4';
const AMBER = '#f5c542';
const RED = '#ff6b6b';
const ROCK = '#8fd9a8';
const JOY_RADIUS = 56;

/** Tank steering: [thrust, turn] per key. Any other key only starts or restarts a round. */
const STEER_KEYS: Record<string, [number, number]> = {
  ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
  w: [1, 0], s: [-1, 0], a: [0, -1], d: [0, 1],
};
/** The loadout: each weapon's key, its number-key alternative, and its name. */
export const LOADOUT: { weapon: Weapon; key: string; alt: string; label: string; name: string }[] = [
  { weapon: 'blaster', key: ' ', alt: '1', label: 'Space', name: 'Blaster' },
  { weapon: 'missile', key: 'q', alt: '2', label: 'Q', name: 'Missile' },
  { weapon: 'seeker', key: 'e', alt: '3', label: 'E', name: 'Heat-seeker' },
  { weapon: 'mortar', key: 'r', alt: '4', label: 'R', name: 'Mortar' },
  { weapon: 'bomb', key: 'f', alt: '5', label: 'F', name: 'A-bomb' },
];
const weaponFor = (key: string) => LOADOUT.find((l) => l.key === key.toLowerCase() || l.alt === key)?.weapon;
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
  for (const m of g.missiles) {
    if (m.kind === 'mortar') {
      // A lobbed shell: bigger at the top of its arc, with its landing spot marked.
      const k = Math.min(1, m.t / m.dur), lift = Math.sin(Math.PI * k);
      ctx.strokeStyle = 'rgba(245,197,66,.35)';
      ctx.beginPath(); ctx.arc(m.tx, m.ty, 10, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = AMBER;
      ctx.beginPath(); ctx.arc(m.x, m.y - lift * 40, 4 + lift * 4, 0, Math.PI * 2); ctx.fill();
    } else {
      const a = Math.atan2(m.vy, m.vx);
      ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(a);
      ctx.strokeStyle = m.kind === 'seeker' ? AMBER : PALE; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-6, -3); ctx.lineTo(-6, 3); ctx.closePath(); ctx.stroke();
      ctx.strokeStyle = RED; ctx.beginPath(); ctx.moveTo(-7, 0); ctx.lineTo(-13, 0); ctx.stroke();
      ctx.restore();
    }
  }
  for (const b of g.blasts) {
    const k = Math.min(1, (g.time - b.at) / 0.4);
    ctx.strokeStyle = `rgba(245,197,66,${1 - k})`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r * (0.3 + 0.7 * k), 0, Math.PI * 2); ctx.stroke();
  }
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
  if (g.time < g.flashUntil) {
    ctx.fillStyle = `rgba(255,255,255,${(g.flashUntil - g.time) / 0.35})`;
    ctx.fillRect(0, 0, w, h);
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
 * wall. On a desktop the keys steer like a tank (up thrusts the way the ship points,
 * left/right turn, down brakes then reverses) and each weapon has a key (LOADOUT); the mouse
 * only starts a round. On a phone one joystick moves, the blaster fires on its own, and the
 * other weapons have buttons.
 * It starts at the first key or tap, and a round never ends the update or the other way round.
 */
export function Blaster({ getWall, paused }: { getWall: () => Rect | null; paused: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const game = useRef<Game | null>(null);
  const [started, setStarted] = useState(false);
  const [hud, setHud] = useState({ score: 0, lives: 3, wave: 1, combo: 0, over: false, bombs: 1, cd: '' });
  const [touchMode, setTouchMode] = useState(false);
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
    setHud({ score: 0, lives: 3, wave: 1, combo: 0, over: false, bombs: 1, cd: '' });
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
    const norm = (k: string) => (k.length === 1 ? k.toLowerCase() : k);
    const syncSteer = () => {
      let thrust = 0, turn = 0;
      for (const k of keys.current) { const m = STEER_KEYS[k]; if (m) { thrust += m[0]; turn += m[1]; } }
      input.current.thrust = Math.max(-1, Math.min(1, thrust));
      input.current.turn = Math.max(-1, Math.min(1, turn));
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (wake()) return;
      const k = norm(e.key);
      const weapon = weaponFor(k);
      if (STEER_KEYS[k] || weapon) e.preventDefault();
      // Keys take over from the touch joystick.
      input.current.autoAim = false;
      input.current.move = { x: 0, y: 0 };
      if (weapon === 'blaster') input.current.fire = true;
      else if (weapon && !e.repeat) input.current.trigger = [...(input.current.trigger ?? []), weapon];
      keys.current.add(k);
      syncSteer();
    };
    const up = (e: KeyboardEvent) => {
      const k = norm(e.key);
      if (weaponFor(k) === 'blaster') input.current.fire = false;
      keys.current.delete(k);
      syncSteer();
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
        if (!pausedRef.current && !document.hidden) { step(g, dt, input.current, wall); input.current.trigger = []; }
        if (g.score > roundBest.current && now - lastSave > 1000) { recordBest(g.score, roundBest.current); lastSave = now; setBest(g.score); }
        // Cooldowns as tenths, so the bar redraws ~10 times a second, not every frame.
        const cd = LOADOUT.map((l) => Math.ceil((g.cd[l.weapon] / COOLDOWN[l.weapon]) * 10)).join(',');
        setHud((prev) => (prev.score === g.score && prev.lives === g.lives && prev.wave === g.wave && prev.combo === g.combo && prev.over === g.over && prev.bombs === g.bombs && prev.cd === cd
          ? prev : { score: g.score, lives: g.lives, wave: g.wave, combo: g.combo, over: g.over, bombs: g.bombs, cd }));
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
      setTouchMode(true);
      input.current.autoAim = true;
      input.current.thrust = undefined;
      input.current.turn = undefined;
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
        onTouchStart={() => { setTouchMode(true); input.current.autoAim = true; input.current.thrust = undefined; input.current.turn = undefined; }}
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
          {/* The loadout: key, name, and a cooldown bar (the A-bomb shows its ammo instead). */}
          <ul aria-label="Loadout" style={{ position: 'absolute', left: 0, right: 0, bottom: 'max(10px, env(safe-area-inset-bottom))', margin: 0, padding: 0, listStyle: 'none', display: touchMode ? 'none' : 'flex', justifyContent: 'center', gap: 8, pointerEvents: 'none' }}>
            {LOADOUT.map((l, k) => {
              const left = Number(hud.cd.split(',')[k] ?? 0) / 10;
              const empty = l.weapon === 'bomb' && hud.bombs <= 0;
              return (
                <li key={l.weapon} style={{ minWidth: 92, padding: '5px 8px 6px', border: '1px solid rgba(62,207,106,.3)', borderRadius: 6, background: 'rgba(6,9,8,.75)', opacity: empty ? 0.35 : 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
                    <span style={{ color: PALE }}>{l.label}</span>
                    <span style={{ color: l.weapon === 'bomb' ? RED : GREEN }}>{l.name}</span>
                  </div>
                  {l.weapon === 'bomb'
                    ? <div aria-label={`A-bombs: ${hud.bombs}`} style={{ marginTop: 3, fontSize: 11, color: RED, letterSpacing: 2 }}>{'●'.repeat(hud.bombs) || '—'}</div>
                    : <div style={{ marginTop: 4, height: 3, background: 'rgba(62,207,106,.15)', borderRadius: 2 }}><div style={{ width: `${(1 - left) * 100}%`, height: '100%', background: left > 0 ? 'rgba(62,207,106,.5)' : GREEN, borderRadius: 2 }} /></div>}
                </li>
              );
            })}
          </ul>
          {touchMode && (
            <div style={{ position: 'absolute', right: 12, bottom: 'max(70px, calc(env(safe-area-inset-bottom) + 60px))', display: 'grid', gridTemplateColumns: 'repeat(2, 58px)', gap: 8 }}>
              {LOADOUT.filter((l) => l.weapon !== 'blaster').map((l) => (
                <button key={l.weapon} type="button" aria-label={`Fire ${l.name}`}
                  onPointerDown={(e) => { e.stopPropagation(); touch(); input.current.trigger = [...(input.current.trigger ?? []), l.weapon]; }}
                  style={{ height: 46, borderRadius: 10, border: `1px solid ${l.weapon === 'bomb' ? RED : 'rgba(62,207,106,.5)'}`, background: 'rgba(6,9,8,.8)', color: l.weapon === 'bomb' ? RED : GREEN, fontFamily: mono, fontSize: 10.5, touchAction: 'none', opacity: l.weapon === 'bomb' && hud.bombs <= 0 ? 0.35 : 1 }}>
                  {l.name}{l.weapon === 'bomb' ? ` ${hud.bombs}` : ''}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {(!started || hud.over) && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 'max(28px, env(safe-area-inset-bottom))', textAlign: 'center', pointerEvents: 'none', color: 'rgba(214,255,228,.85)', fontSize: 13, letterSpacing: 1 }}>
          {hud.over && <div style={{ fontSize: 18, fontWeight: 700, color: RED, marginBottom: 6 }}>GAME OVER · {hud.score.toLocaleString()}</div>}
          {hud.over ? 'Press any key or tap to play again' : 'Press any key or tap to play'}
          <div style={{ marginTop: 6, fontSize: 11, color: 'rgba(214,255,228,.5)' }}>Up thrusts · Left/Right turn · Down brakes · Space blaster · Q missile · E seeker · R mortar · F A-bomb · On a phone, drag to move</div>
        </div>
      )}
    </div>
  );
}
