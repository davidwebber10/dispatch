import { describe, it, expect } from 'vitest';
import { newGame, step, type Game, type Input, type Rect } from './engine';

const W = 800, H = 600;
const idle: Input = { move: { x: 0, y: 0 }, aim: null, fire: false, autoAim: false };
const run = (g: Game, input: Input, secs: number, wall: Rect | null = null) => {
  for (let t = 0; t < secs; t += 1 / 60) step(g, 1 / 60, input, wall);
};
const empty = () => { const g = newGame(W, H, () => 0.5); g.enemies = []; g.waveClearAt = Infinity; return g; };

describe('blaster engine', () => {
  it('the ship moves with the input and stays inside the screen', () => {
    const g = empty();
    g.ship.x = 400; g.ship.y = 300;
    run(g, { ...idle, move: { x: 1, y: 0 } }, 0.5);
    expect(g.ship.x).toBeGreaterThan(450);
    run(g, { ...idle, move: { x: 1, y: 0 } }, 5);
    expect(g.ship.x).toBeLessThanOrEqual(W - g.ship.r);
  });

  it('the status card is a wall: the ship cannot fly through it', () => {
    const g = empty();
    const wall: Rect = { x: 300, y: 200, w: 200, h: 200 };
    g.ship.x = 250; g.ship.y = 300;
    run(g, { ...idle, move: { x: 1, y: 0 } }, 2, wall);
    expect(g.ship.x).toBeLessThanOrEqual(300 - g.ship.r + 0.5);
  });

  it('a shot stops at the wall', () => {
    const g = empty();
    const wall: Rect = { x: 300, y: 200, w: 200, h: 200 };
    g.ship.x = 250; g.ship.y = 300;
    step(g, 1 / 60, { ...idle, aim: { x: 700, y: 300 }, fire: true }, wall);
    expect(g.shots.length).toBe(1);
    run(g, idle, 0.3, wall);
    expect(g.shots.length).toBe(0);
  });

  it('a shot destroys a drone and scores points; quick kills raise the combo', () => {
    const g = empty();
    g.ship.x = 100; g.ship.y = 300;
    g.enemies.push({ kind: 'drone', x: 300, y: 300, vx: 0, vy: 0, r: 9, hp: 1, cooldown: 99 });
    run(g, { ...idle, aim: { x: 300, y: 300 }, fire: true }, 0.6);
    expect(g.enemies.length).toBe(0);
    expect(g.score).toBeGreaterThanOrEqual(100);
    expect(g.combo).toBe(1);
  });

  it('an asteroid breaks into two smaller pieces', () => {
    const g = empty();
    g.ship.x = 100; g.ship.y = 300;
    g.enemies.push({ kind: 'asteroid', x: 300, y: 300, vx: 0, vy: 0, r: 28, hp: 1, cooldown: 99 });
    run(g, { ...idle, aim: { x: 300, y: 300 }, fire: true }, 0.35);
    const rocks = g.enemies.filter((e) => e.kind === 'asteroid');
    expect(rocks.length).toBe(2);
    expect(rocks.every((r) => r.r < 28)).toBe(true);
  });

  it('a hit costs a life and gives a short shield; three hits end the game', () => {
    const g = empty();
    g.ship.x = 400; g.ship.y = 300;
    for (let k = 0; k < 3; k++) {
      g.ship.shield = 0;
      g.enemyShots.push({ x: 400, y: 300, vx: 0, vy: 0, life: 1 });
      step(g, 1 / 60, idle, null);
      expect(g.lives).toBe(2 - k);
      expect(g.ship.shield > 0 || g.over).toBe(true);
    }
    expect(g.over).toBe(true);
  });

  it('when a wave is cleared, the next wave is bigger', () => {
    const g = newGame(W, H, () => 0.5);
    const first = g.enemies.length;
    g.enemies = [];
    run(g, idle, 3);
    expect(g.wave).toBe(2);
    expect(g.enemies.length).toBeGreaterThan(first);
  });

  it('enemies never spawn inside the wall or on top of the ship', () => {
    const wall: Rect = { x: 250, y: 150, w: 300, h: 300 };
    const g = newGame(W, H, Math.random, wall);
    for (const e of g.enemies) {
      const inWall = e.x > wall.x && e.x < wall.x + wall.w && e.y > wall.y && e.y < wall.y + wall.h;
      expect(inWall).toBe(false);
      expect(Math.hypot(e.x - g.ship.x, e.y - g.ship.y)).toBeGreaterThan(150);
    }
  });

  it('auto-aim fires at the nearest enemy (the phone mode)', () => {
    const g = empty();
    g.ship.x = 400; g.ship.y = 300;
    g.enemies.push({ kind: 'drone', x: 400, y: 100, vx: 0, vy: 0, r: 9, hp: 1, cooldown: 99 });
    step(g, 1 / 60, { ...idle, autoAim: true }, null);
    expect(g.shots.length).toBe(1);
    expect(g.shots[0].vy).toBeLessThan(0);
    expect(Math.abs(g.shots[0].vx)).toBeLessThan(1);
  });
});
