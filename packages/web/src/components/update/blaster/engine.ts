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
  /** Keys (tank steering): 1 thrusts the way the ship points, -1 brakes then reverses. */
  thrust?: number;
  /** Keys: -1 turns left, 1 turns right. */
  turn?: number;
  /** Weapons pressed this frame (each press fires once, if its cooldown and ammo allow). */
  trigger?: Weapon[];
}
export type Weapon = 'blaster' | 'missile' | 'seeker' | 'mortar' | 'bomb';
export type ProjectileKind = 'missile' | 'seeker' | 'mortar';
export interface Projectile { kind: ProjectileKind; x: number; y: number; vx: number; vy: number; life: number; sx: number; sy: number; tx: number; ty: number; t: number; dur: number }
export interface Blast { x: number; y: number; r: number; at: number }
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
  missiles: Projectile[];
  blasts: Blast[];
  /** A-bombs left (1 at the start, +1 each wave, at most MAX_BOMBS). */
  bombs: number;
  /** Seconds until each weapon can fire again. */
  cd: Record<Weapon, number>;
  /** The A-bomb's white flash ends at this time. */
  flashUntil: number;
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
/** Tank steering. */
const TURN_RATE = 4;
const THRUST = 500;
const MAX_SPEED = 320;
const BRAKE = 700;
const REVERSE = 200;
const MAX_REVERSE = 120;
const DRIFT = 1.2;
/** The loadout. */
export const COOLDOWN: Record<Weapon, number> = { blaster: 1 / FIRE_RATE, missile: 0.9, seeker: 2.5, mortar: 1.8, bomb: 0.5 };
export const MAX_BOMBS = 2;
const MISSILE = { speed: 380, accel: 600, max: 750, life: 2, blast: 60, dmg: 2 };
const SEEKER = { speed: 330, turn: 3.2, life: 4, blast: 45, dmg: 2 };
const MORTAR = { range: 260, dur: 0.8, blast: 110, dmg: 3 };
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
    missiles: [], blasts: [], bombs: 1, cd: { blaster: 0, missile: 0, seeker: 0, mortar: 0, bomb: 0 }, flashUntil: 0,
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

/** Damage every enemy inside the blast; returns nothing (kills score as usual). */
function explode(g: Game, x: number, y: number, r: number, dmg: number): void {
  g.blasts.push({ x, y, r, at: g.time });
  burst(g, x, y, 16);
  for (const e of [...g.enemies]) {
    if (e.hp > 0 && Math.hypot(e.x - x, e.y - y) < r + e.r) { e.hp -= dmg; if (e.hp <= 0) kill(g, e); }
  }
}

function fireWeapon(g: Game, w: Weapon): void {
  if (g.cd[w] > 0) return;
  const s = g.ship;
  const dx = Math.cos(s.angle), dy = Math.sin(s.angle);
  const at = { x: s.x + dx * s.r, y: s.y + dy * s.r };
  if (w === 'blaster') {
    g.shots.push({ ...at, vx: dx * SHOT_SPEED, vy: dy * SHOT_SPEED, life: 1.1 });
  } else if (w === 'bomb') {
    if (g.bombs <= 0) return;
    g.bombs -= 1;
    for (const e of g.enemies) { g.score += POINTS[e.kind]; burst(g, e.x, e.y, 10); }
    g.enemies = [];
    g.enemyShots = [];
    g.flashUntil = g.time + 0.35;
    // It hurts you too, through any shield.
    g.lives -= 1;
    burst(g, s.x, s.y, 18);
    if (g.lives <= 0) g.over = true; else s.shield = SHIELD_SECS;
  } else {
    const base = { ...at, sx: at.x, sy: at.y, t: 0 };
    if (w === 'missile') g.missiles.push({ ...base, kind: 'missile', vx: dx * MISSILE.speed, vy: dy * MISSILE.speed, life: MISSILE.life, tx: 0, ty: 0, dur: 0 });
    else if (w === 'seeker') g.missiles.push({ ...base, kind: 'seeker', vx: dx * SEEKER.speed, vy: dy * SEEKER.speed, life: SEEKER.life, tx: 0, ty: 0, dur: 0 });
    else {
      const tx = Math.max(10, Math.min(g.w - 10, s.x + dx * MORTAR.range)), ty = Math.max(10, Math.min(g.h - 10, s.y + dy * MORTAR.range));
      g.missiles.push({ ...base, kind: 'mortar', vx: 0, vy: 0, life: MORTAR.dur + 1, tx, ty, dur: MORTAR.dur });
    }
  }
  g.cd[w] = COOLDOWN[w];
}

function stepMissiles(g: Game, dt: number, wall: Rect | null): void {
  for (const m of g.missiles) {
    m.t += dt; m.life -= dt;
    if (m.kind === 'mortar') {
      // Lobbed: it flies over the status card and lands on its target.
      const k = Math.min(1, m.t / m.dur);
      m.x = m.sx + (m.tx - m.sx) * k; m.y = m.sy + (m.ty - m.sy) * k;
      if (k >= 1) { explode(g, m.x, m.y, MORTAR.blast, MORTAR.dmg); m.life = 0; }
      continue;
    }
    if (m.kind === 'missile') {
      const sp = Math.min(MISSILE.max, Math.hypot(m.vx, m.vy) + MISSILE.accel * dt), a = Math.atan2(m.vy, m.vx);
      m.vx = Math.cos(a) * sp; m.vy = Math.sin(a) * sp;
    } else {
      const target = nearestTo(g, m.x, m.y, 2000);
      if (target) {
        const a = Math.atan2(m.vy, m.vx), want = Math.atan2(target.y - m.y, target.x - m.x);
        let d = want - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        const na = a + Math.max(-SEEKER.turn * dt, Math.min(SEEKER.turn * dt, d));
        m.vx = Math.cos(na) * SEEKER.speed; m.vy = Math.sin(na) * SEEKER.speed;
      }
    }
    m.x += m.vx * dt; m.y += m.vy * dt;
    const spec = m.kind === 'missile' ? MISSILE : SEEKER;
    const hit = g.enemies.some((e) => e.hp > 0 && Math.hypot(e.x - m.x, e.y - m.y) < e.r + 4);
    const blocked = (wall && inRect(m.x, m.y, wall)) || m.x < 0 || m.x > g.w || m.y < 0 || m.y > g.h;
    if (hit || blocked || m.life <= 0) { explode(g, m.x, m.y, spec.blast, spec.dmg); m.life = 0; }
  }
  g.missiles = g.missiles.filter((m) => m.life > 0);
  g.enemies = g.enemies.filter((e) => e.hp > 0);
  g.blasts = g.blasts.filter((b) => g.time - b.at < 0.4);
}

function nearestTo(g: Game, x: number, y: number, range: number): Enemy | null {
  let best: Enemy | null = null, bd = range;
  for (const e of g.enemies) {
    const d = Math.hypot(e.x - x, e.y - y);
    if (e.hp > 0 && d < bd) { bd = d; best = e; }
  }
  return best;
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
  const tank = input.thrust !== undefined || input.turn !== undefined;
  if (tank && ml < 0.1) {
    // Keys: up thrusts the way the ship points, left/right turn, down brakes then reverses.
    s.angle += (input.turn ?? 0) * TURN_RATE * dt;
    const hx = Math.cos(s.angle), hy = Math.sin(s.angle);
    const thrust = input.thrust ?? 0;
    const fwd = s.vx * hx + s.vy * hy;
    if (thrust > 0) {
      s.vx += hx * THRUST * thrust * dt; s.vy += hy * THRUST * thrust * dt;
      const sp = Math.hypot(s.vx, s.vy);
      if (sp > MAX_SPEED) { s.vx *= MAX_SPEED / sp; s.vy *= MAX_SPEED / sp; }
    } else if (thrust < 0) {
      if (fwd > 5) {
        const cut = Math.min(fwd, BRAKE * dt);
        s.vx -= hx * cut; s.vy -= hy * cut;
      } else if (fwd > -MAX_REVERSE) {
        s.vx -= hx * REVERSE * dt; s.vy -= hy * REVERSE * dt;
      }
    } else {
      const drag = Math.exp(-DRIFT * dt);
      s.vx *= drag; s.vy *= drag;
    }
  } else {
    const k = Math.min(1, dt * 10);
    s.vx += (mx * SHIP_SPEED - s.vx) * k;
    s.vy += (my * SHIP_SPEED - s.vy) * k;
  }
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
  for (const w of Object.keys(g.cd) as Weapon[]) g.cd[w] = Math.max(0, g.cd[w] - dt);
  s.fireCd = g.cd.blaster;
  const firing = input.fire || (input.autoAim && target !== null);
  if (firing) fireWeapon(g, 'blaster');
  for (const w of input.trigger ?? []) fireWeapon(g, w);
  if (g.over) return;
  stepMissiles(g, dt, wall);

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
    g.bombs = Math.min(MAX_BOMBS, g.bombs + 1);
    spawnWave(g, wall);
  }
}
