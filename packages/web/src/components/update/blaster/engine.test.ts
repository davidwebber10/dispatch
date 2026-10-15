import { describe, it, expect } from 'vitest';
import { newGame, step, type Game, type Input, type Rect, type Weapon } from './engine';

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
  it('keys only: the ship points where it moves, keeps that heading when it stops, and fires that way', () => {
    const g = empty();
    g.ship.x = 400; g.ship.y = 300;
    run(g, { ...idle, move: { x: 0, y: -1 } }, 0.2);
    step(g, 1 / 60, { ...idle, fire: true }, null);
    expect(g.shots.length).toBe(1);
    expect(g.shots[0].vy).toBeLessThan(0);
    expect(Math.abs(g.shots[0].vx)).toBeLessThan(1);
    run(g, { ...idle, move: { x: -1, y: 0 } }, 0.2);
    g.shots = []; g.ship.fireCd = 0;
    step(g, 1 / 60, { ...idle, fire: true }, null);
    expect(g.shots[0].vx).toBeLessThan(0);
  });
  it('hard from the start: wave 1 has 6 drones, 2 gunships and an asteroid', () => {
    const g = newGame(W, H, Math.random);
    const count = (k: string) => g.enemies.filter((e) => e.kind === k).length;
    expect([count('drone'), count('gunship'), count('asteroid')]).toEqual([6, 2, 1]);
  });

  it('drones are fast: they close a 300 px gap in about 2 seconds', () => {
    const g = empty();
    g.ship.x = 100; g.ship.y = 300; g.ship.shield = 99;
    g.enemies.push({ kind: 'drone', x: 400, y: 300, vx: 0, vy: 0, r: 9, hp: 1, cooldown: 99 });
    run(g, idle, 2);
    const d = g.enemies[0];
    expect(!d || Math.hypot(d.x - g.ship.x, d.y - g.ship.y) < 40).toBe(true);
  });

  it('from wave 3, a gunship fires a spread of 3 shots', () => {
    const g = empty();
    g.wave = 3;
    g.ship.x = 100; g.ship.y = 300; g.ship.shield = 99;
    g.enemies.push({ kind: 'gunship', x: 400, y: 300, vx: 0, vy: 0, r: 13, hp: 3, cooldown: 0 });
    step(g, 1 / 60, idle, null);
    expect(g.enemyShots.length).toBe(3);
  });

  it('reinforcements arrive during a wave', () => {
    const g = empty();
    g.waveClearAt = null;
    g.ship.shield = 999;
    g.enemies.push({ kind: 'asteroid', x: 50, y: 50, vx: 0, vy: 0, r: 28, hp: 1, cooldown: 99 });
    run(g, idle, 7);
    expect(g.enemies.filter((e) => e.kind === 'drone').length).toBeGreaterThanOrEqual(1);
  });

  it('the shield after a hit is short (1.2 s)', () => {
    const g = empty();
    g.ship.shield = 0;
    g.enemyShots.push({ x: g.ship.x, y: g.ship.y, vx: 0, vy: 0, life: 1 });
    step(g, 1 / 60, idle, null);
    expect(g.ship.shield).toBeCloseTo(1.2, 1);
  });
  describe('tank steering (keys)', () => {
    const keys = (thrust: number, turn: number, trigger: Weapon[] = []): Input => ({ ...idle, thrust, turn, trigger });

    it('up thrusts the way the ship points; left and right turn it', () => {
      const g = empty();
      g.ship.x = 400; g.ship.y = 300; g.ship.angle = 0; // pointing right
      run(g, keys(1, 0), 0.5);
      expect(g.ship.x).toBeGreaterThan(430);
      expect(Math.abs(g.ship.y - 300)).toBeLessThan(2);
      const before = g.ship.angle;
      run(g, keys(0, -1), 0.25);
      expect(g.ship.angle).toBeLessThan(before - 0.5); // turned left (counter-clockwise on screen)
    });

    it('down brakes first, then reverses slowly', () => {
      const g = empty();
      g.ship.x = 400; g.ship.y = 300; g.ship.angle = 0;
      run(g, keys(1, 0), 0.6);
      const fast = g.ship.vx;
      run(g, keys(-1, 0), 0.15);
      expect(g.ship.vx).toBeLessThan(fast);
      expect(g.ship.vx).toBeGreaterThan(-1);
      run(g, keys(-1, 0), 1.5);
      expect(g.ship.vx).toBeLessThan(0);
      expect(g.ship.vx).toBeGreaterThan(-140); // reverse is slow
    });

    it('with no thrust the ship drifts and slows down', () => {
      const g = empty();
      g.ship.x = 200; g.ship.y = 300; g.ship.angle = 0;
      run(g, keys(1, 0), 0.5);
      const v = g.ship.vx;
      run(g, keys(0, 0), 1);
      expect(g.ship.vx).toBeGreaterThan(0);
      expect(g.ship.vx).toBeLessThan(v * 0.5);
    });
  });

  describe('loadout', () => {
    const fireOnce = (g: Game, w: Weapon, wall: Rect | null = null) => step(g, 1 / 60, { ...idle, trigger: [w] }, wall);

    it('a missile explodes on a hit and its blast also destroys a drone next to the target', () => {
      const g = empty();
      g.ship.x = 100; g.ship.y = 300; g.ship.angle = 0;
      g.enemies.push({ kind: 'drone', x: 400, y: 300, vx: 0, vy: 0, r: 9, hp: 1, cooldown: 99 });
      g.enemies.push({ kind: 'drone', x: 400, y: 340, vx: 0, vy: 0, r: 9, hp: 1, cooldown: 99 });
      fireOnce(g, 'missile');
      run(g, { ...idle, thrust: 0, turn: 0 }, 1.2);
      expect(g.enemies.length).toBe(0);
    });

    it('a heat-seeker turns toward an enemy that is not in front of the ship', () => {
      const g = empty();
      g.ship.x = 400; g.ship.y = 500; g.ship.angle = 0; // pointing right
      g.enemies.push({ kind: 'gunship', x: 400, y: 120, vx: 0, vy: 0, r: 13, hp: 2, cooldown: 99 });
      fireOnce(g, 'seeker');
      run(g, { ...idle, thrust: 0, turn: 0 }, 3);
      expect(g.enemies.length).toBe(0);
    });

    it('a mortar flies over the status card and blasts the far side', () => {
      const g = empty();
      const wall: Rect = { x: 250, y: 260, w: 100, h: 80 };
      g.ship.x = 150; g.ship.y = 300; g.ship.angle = 0;
      g.enemies.push({ kind: 'drone', x: 410, y: 300, vx: 0, vy: 0, r: 9, hp: 1, cooldown: 99 });
      fireOnce(g, 'mortar', wall);
      run(g, { ...idle, thrust: 0, turn: 0 }, 1.2, wall);
      expect(g.enemies.length).toBe(0);
    });

    it('the A-bomb clears every enemy and enemy shot, costs a life even with a shield, and uses ammo', () => {
      const g = empty();
      g.ship.shield = 5;
      for (let k = 0; k < 5; k++) g.enemies.push({ kind: 'drone', x: 100 + k * 120, y: 100, vx: 0, vy: 0, r: 9, hp: 1, cooldown: 99 });
      g.enemyShots.push({ x: 700, y: 500, vx: 0, vy: 0, life: 3 });
      expect(g.bombs).toBe(1);
      fireOnce(g, 'bomb');
      expect(g.enemies.length).toBe(0);
      expect(g.enemyShots.length).toBe(0);
      expect(g.lives).toBe(2);
      expect(g.bombs).toBe(0);
      expect(g.score).toBeGreaterThanOrEqual(500);
      g.enemies.push({ kind: 'drone', x: 100, y: 100, vx: 0, vy: 0, r: 9, hp: 1, cooldown: 99 });
      fireOnce(g, 'bomb');
      expect(g.enemies.length).toBe(1); // no ammo left
    });

    it('the A-bomb on the last life ends the game', () => {
      const g = empty();
      g.lives = 1;
      fireOnce(g, 'bomb');
      expect(g.over).toBe(true);
    });

    it('each weapon has its own cooldown', () => {
      const g = empty();
      g.ship.angle = 0;
      fireOnce(g, 'missile');
      fireOnce(g, 'missile');
      expect(g.missiles.filter((m) => m.kind === 'missile').length).toBe(1);
      fireOnce(g, 'seeker');
      expect(g.missiles.filter((m) => m.kind === 'seeker').length).toBe(1);
    });

    it('a new wave gives one more A-bomb, up to 2', () => {
      const g = newGame(W, H, () => 0.5);
      g.bombs = 1;
      for (let k = 0; k < 3; k++) { g.enemies = []; run(g, idle, 2); }
      expect(g.bombs).toBe(2);
    });
  });
});
