/**
 * The update blaster: a top-down arena shooter that runs while Dispatch updates.
 * Pure game rules, no DOM: `step` advances one frame from an Input and the status
 * card's rectangle (a wall that ships and shots cannot pass). Blaster.tsx draws it.
 */
export interface Rect { x: number; y: number; w: number; h: number }
export interface Vec { x: number; y: number }
export interface Input {
  /** -1..1 on each axis (keys or the touch joystick). */
  move: Vec;
  /** Where the mouse points, or null. */
  aim: Vec | null;
  /** The fire button is held. */
  fire: boolean;
  /** Phone mode: aim and fire at the nearest enemy without a button. */
  autoAim: boolean;
}
export type EnemyKind = 'drone' | 'gunship' | 'asteroid';
export interface Enemy { kind: EnemyKind; x: number; y: number; vx: number; vy: number; r: number; hp: number; cooldown: number }
export interface Shot { x: number; y: number; vx: number; vy: number; life: number }
export interface Particle { x: number; y: number; vx: number; vy: number; life: number }
export interface Ship { x: number; y: number; vx: number; vy: number; r: number; angle: number; shield: number; fireCd: number }
export interface Game {
  w: number; h: number;
  rand: () => number;
  ship: Ship;
  shots: Shot[];
  enemyShots: Shot[];
  enemies: Enemy[];
  particles: Particle[];
  score: number;
  lives: number;
  wave: number;
  combo: number;
  lastKillAt: number;
  time: number;
  /** When the next wave starts (null: not scheduled, so a wave is on). */
  waveClearAt: number | null;
  /** When the next reinforcement drone arrives during a wave. */
  reinforceAt: number;
  banner: { text: string; until: number } | null;
  over: boolean;
  aliveAcc: number;
}

const SHIP_SPEED = 260;
const SHOT_SPEED = 620;
const FIRE_RATE = 7;
const AUTO_AIM_RANGE = 600;
/** The shield after a hit (a new round starts with START_SHIELD, so the first spawn is fair). */
const SHIELD_SECS = 1.2;
const START_SHIELD = 2;
/** Difficulty: hard from wave 1, and harder every wave. */
const DRONE_SPEED = 160;
const DRONE_ACCEL = 3;
const GUN_SHOT_SPEED = 300;
const SPREAD_FROM_WAVE = 3;
const MAX_ENEMIES = 28;
const reinforceEvery = (wave: number) => Math.max(2.5, 6 - 0.4 * wave);
const POINTS: Record<EnemyKind, number> = { drone: 100, gunship: 250, asteroid: 50 };
const COMBO_WINDOW = 1.5;
const MAX_COMBO = 5;

export function newGame(w: number, h: number, rand: () => number = Math.random, wall: Rect | null = null): Game {
  const g: Game = {
    w, h, rand,
    ship: { x: w / 2, y: h - 60, vx: 0, vy: 0, r: 10, angle: -Math.PI / 2, shield: START_SHIELD, fireCd: 0 },
    shots: [], enemyShots: [], enemies: [], particles: [],
    score: 0, lives: 3, wave: 1, combo: 0, lastKillAt: -10, time: 0, waveClearAt: null, reinforceAt: reinforceEvery(1),
    banner: { text: 'WAVE 1', until: 1.5 }, over: false, aliveAcc: 0,
  };
  spawnWave(g, wall);
  return g;
}

const inRect = (x: number, y: number, r: Rect, pad = 0) => x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad;

/** A point on the screen edge, outside the wall and away from the ship. */
function spawnPoint(g: Game, wall: Rect | null): Vec {
  const m = 20;
  for (let k = 0; k < 20; k++) {
    const t = g.rand();
    const side = Math.floor(g.rand() * 4);
    const p = side === 0 ? { x: m + t * (g.w - 2 * m), y: m } : side === 1 ? { x: g.w - m, y: m + t * (g.h - 2 * m) }
      : side === 2 ? { x: m + t * (g.w - 2 * m), y: g.h - m } : { x: m, y: m + t * (g.h - 2 * m) };
    if (wall && inRect(p.x, p.y, wall, 30)) continue;
    if (Math.hypot(p.x - g.ship.x, p.y - g.ship.y) < 200) continue;
    return p;
  }
  // The corner farthest from the ship.
  const corners = [{ x: m, y: m }, { x: g.w - m, y: m }, { x: m, y: g.h - m }, { x: g.w - m, y: g.h - m }];
  return corners.reduce((a, b) => (Math.hypot(b.x - g.ship.x, b.y - g.ship.y) > Math.hypot(a.x - g.ship.x, a.y - g.ship.y) ? b : a));
}

function spawnWave(g: Game, wall: Rect | null): void {
  const add = (kind: EnemyKind, n: number) => {
    for (let k = 0; k < n; k++) {
      const p = spawnPoint(g, wall);
      const a = g.rand() * Math.PI * 2;
      const speed = kind === 'asteroid' ? 70 + g.rand() * 60 : 0;
      g.enemies.push({ kind, x: p.x, y: p.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        r: kind === 'asteroid' ? 28 : kind === 'gunship' ? 13 : 9, hp: kind === 'gunship' ? 3 : 1, cooldown: 1.5 + g.rand() * 1.5 });
    }
  };
  add('drone', 4 + 2 * g.wave);
  add('gunship', 1 + g.wave);
  add('asteroid', 1 + Math.floor(g.wave / 2));
}

function reinforce(g: Game, wall: Rect | null): void {
  if (g.enemies.length >= MAX_ENEMIES) return;
  const p = spawnPoint(g, wall);
  g.enemies.push({ kind: 'drone', x: p.x, y: p.y, vx: 0, vy: 0, r: 9, hp: 1, cooldown: 99 });
}

function burst(g: Game, x: number, y: number, n: number): void {
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + g.rand();
    const s = 60 + g.rand() * 160;
    g.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.4 + g.rand() * 0.4 });
  }
}

/** Push a circle out of the wall; returns the push normal when it touched. */
function pushOut(o: { x: number; y: number }, r: number, wall: Rect): Vec | null {
  const cx = Math.max(wall.x, Math.min(o.x, wall.x + wall.w));
  const cy = Math.max(wall.y, Math.min(o.y, wall.y + wall.h));
  let dx = o.x - cx, dy = o.y - cy;
  let d = Math.hypot(dx, dy);
  if (d >= r) return null;
  if (d === 0) {
    // The centre is inside: leave by the nearest edge.
    const opts = [
      { d: o.x - wall.x, nx: -1, ny: 0 }, { d: wall.x + wall.w - o.x, nx: 1, ny: 0 },
      { d: o.y - wall.y, nx: 0, ny: -1 }, { d: wall.y + wall.h - o.y, nx: 0, ny: 1 },
    ].sort((a, b) => a.d - b.d)[0];
    o.x += opts.nx * (opts.d + r); o.y += opts.ny * (opts.d + r);
    return { x: opts.nx, y: opts.ny };
  }
  dx /= d; dy /= d;
  o.x += dx * (r - d); o.y += dy * (r - d);
  return { x: dx, y: dy };
}

function hitShip(g: Game): void {
  if (g.ship.shield > 0 || g.over) return;
  g.lives -= 1;
  burst(g, g.ship.x, g.ship.y, 18);
  if (g.lives <= 0) { g.over = true; return; }
  g.ship.shield = SHIELD_SECS;
}

function kill(g: Game, e: Enemy): void {
  g.combo = g.time - g.lastKillAt < COMBO_WINDOW ? Math.min(g.combo + 1, MAX_COMBO) : 1;
  g.lastKillAt = g.time;
  g.score += POINTS[e.kind] * g.combo;
  burst(g, e.x, e.y, e.kind === 'asteroid' ? 10 : 14);
  if (e.kind === 'asteroid' && e.r > 12) {
    const r = e.r * 0.58;
    for (const s of [-1, 1]) {
      const a = Math.atan2(e.vy, e.vx) + s * (Math.PI / 2);
      const sp = 70 + g.rand() * 50;
      g.enemies.push({ kind: 'asteroid', x: e.x + Math.cos(a) * r, y: e.y + Math.sin(a) * r, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r, hp: 1, cooldown: 99 });
    }
  }
}

function nearestEnemy(g: Game): Enemy | null {
  let best: Enemy | null = null, bd = AUTO_AIM_RANGE;
  for (const e of g.enemies) {
    const d = Math.hypot(e.x - g.ship.x, e.y - g.ship.y);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

export function step(g: Game, dt: number, input: Input, wall: Rect | null): void {
  g.time += dt;
  for (const p of g.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
  g.particles = g.particles.filter((p) => p.life > 0);
  if (g.over) return;

  // Survival points.
  g.aliveAcc += dt;
  while (g.aliveAcc >= 1) { g.aliveAcc -= 1; g.score += 10; }

  // The ship.
  const s = g.ship;
  const ml = Math.hypot(input.move.x, input.move.y);
  const mx = ml > 1 ? input.move.x / ml : input.move.x, my = ml > 1 ? input.move.y / ml : input.move.y;
  const k = Math.min(1, dt * 10);
  s.vx += (mx * SHIP_SPEED - s.vx) * k;
  s.vy += (my * SHIP_SPEED - s.vy) * k;
  s.x = Math.max(s.r, Math.min(g.w - s.r, s.x + s.vx * dt));
  s.y = Math.max(s.r, Math.min(g.h - s.r, s.y + s.vy * dt));
  if (wall) {
    const n = pushOut(s, s.r, wall);
    if (n) { const dot = s.vx * n.x + s.vy * n.y; if (dot < 0) { s.vx -= dot * n.x; s.vy -= dot * n.y; } }
  }
  s.shield = Math.max(0, s.shield - dt);

  // Aim and fire.
  const target = input.aim ?? (input.autoAim ? nearestEnemy(g) : null);
  if (target) s.angle = Math.atan2(target.y - s.y, target.x - s.x);
  else if (ml > 0.1) s.angle = Math.atan2(my, mx);
  s.fireCd -= dt;
  const firing = input.fire || (input.autoAim && target !== null);
  if (firing && s.fireCd <= 0) {
    const dx = Math.cos(s.angle), dy = Math.sin(s.angle);
    g.shots.push({ x: s.x + dx * s.r, y: s.y + dy * s.r, vx: dx * SHOT_SPEED, vy: dy * SHOT_SPEED, life: 1.1 });
    s.fireCd = 1 / FIRE_RATE;
  }

  // Shots: move, stop at the wall and the screen edge, hit enemies.
  const live = (o: Shot) => o.life > 0 && o.x > -10 && o.x < g.w + 10 && o.y > -10 && o.y < g.h + 10 && !(wall && inRect(o.x, o.y, wall));
  for (const o of g.shots) { o.x += o.vx * dt; o.y += o.vy * dt; o.life -= dt; }
  g.shots = g.shots.filter(live);
  for (const o of g.shots) {
    for (const e of g.enemies) {
      if (e.hp > 0 && Math.hypot(o.x - e.x, o.y - e.y) < e.r + 2) { e.hp -= 1; o.life = 0; if (e.hp <= 0) kill(g, e); break; }
    }
  }
  g.shots = g.shots.filter((o) => o.life > 0);
  g.enemies = g.enemies.filter((e) => e.hp > 0);

  // Enemies.
  const speedUp = 1 + (g.wave - 1) * 0.08;
  for (const e of g.enemies) {
    const dx = s.x - e.x, dy = s.y - e.y, d = Math.hypot(dx, dy) || 1;
    if (e.kind === 'drone') {
      const sp = DRONE_SPEED * speedUp;
      e.vx += (dx / d * sp - e.vx) * Math.min(1, dt * DRONE_ACCEL);
      e.vy += (dy / d * sp - e.vy) * Math.min(1, dt * DRONE_ACCEL);
    } else if (e.kind === 'gunship') {
      const away = d < 260 ? -1 : d > 320 ? 1 : 0;
      const sp = 70 * speedUp;
      const tx = (dx / d) * away * sp + (-dy / d) * sp * 0.6, ty = (dy / d) * away * sp + (dx / d) * sp * 0.6;
      e.vx += (tx - e.vx) * Math.min(1, dt * 2);
      e.vy += (ty - e.vy) * Math.min(1, dt * 2);
      e.cooldown -= dt;
      if (e.cooldown <= 0 && d < 700) {
        const base = Math.atan2(dy, dx);
        for (const off of g.wave >= SPREAD_FROM_WAVE ? [-0.25, 0, 0.25] : [0]) {
          g.enemyShots.push({ x: e.x, y: e.y, vx: Math.cos(base + off) * GUN_SHOT_SPEED, vy: Math.sin(base + off) * GUN_SHOT_SPEED, life: 3 });
        }
        e.cooldown = 1.1 + g.rand() * 0.5;
      }
    }
    e.x += e.vx * dt; e.y += e.vy * dt;
    if (e.kind === 'asteroid') {
      // Asteroids wrap around the screen and bounce off the card.
      if (e.x < -e.r) e.x = g.w + e.r; else if (e.x > g.w + e.r) e.x = -e.r;
      if (e.y < -e.r) e.y = g.h + e.r; else if (e.y > g.h + e.r) e.y = -e.r;
      if (wall) { const n = pushOut(e, e.r, wall); if (n) { const dot = e.vx * n.x + e.vy * n.y; if (dot < 0) { e.vx -= 2 * dot * n.x; e.vy -= 2 * dot * n.y; } } }
    } else {
      e.x = Math.max(e.r, Math.min(g.w - e.r, e.x));
      e.y = Math.max(e.r, Math.min(g.h - e.r, e.y));
      if (wall) pushOut(e, e.r, wall);
    }
    if (Math.hypot(s.x - e.x, s.y - e.y) < e.r + s.r && s.shield <= 0) {
      hitShip(g);
      if (e.kind !== 'asteroid') { e.hp = 0; burst(g, e.x, e.y, 10); }
    }
  }
  g.enemies = g.enemies.filter((e) => e.hp > 0);

  // Enemy shots.
  for (const o of g.enemyShots) { o.x += o.vx * dt; o.y += o.vy * dt; o.life -= dt; }
  g.enemyShots = g.enemyShots.filter(live);
  for (const o of g.enemyShots) {
    if (Math.hypot(o.x - s.x, o.y - s.y) < s.r + 3 && s.shield <= 0) { o.life = 0; hitShip(g); }
  }
  g.enemyShots = g.enemyShots.filter((o) => o.life > 0);

  // Reinforcements during a wave.
  if (g.waveClearAt === null && g.enemies.length > 0 && g.time >= g.reinforceAt) {
    reinforce(g, wall);
    g.reinforceAt = g.time + reinforceEvery(g.wave);
  }

  // The next wave.
  if (g.enemies.length === 0 && g.waveClearAt === null) g.waveClearAt = g.time + 1.5;
  if (g.waveClearAt !== null && g.time >= g.waveClearAt) {
    g.wave += 1;
    g.waveClearAt = null;
    g.banner = { text: `WAVE ${g.wave}`, until: g.time + 1.5 };
    g.reinforceAt = g.time + reinforceEvery(g.wave);
    spawnWave(g, wall);
  }
}
