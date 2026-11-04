// packages/core/src/platform/kill-grace.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { killWithGrace } from './kill-grace.js';

const live: ChildProcess[] = [];
afterEach(() => { for (const c of live.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

/** A child that ignores SIGTERM and says so on stdout once the handler is in place. */
async function stubbornChild(): Promise<ChildProcess> {
  const c = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  live.push(c);
  await new Promise<void>((resolve) => c.stdout!.once('data', () => resolve()));
  return c;
}
const exited = (c: ChildProcess) => new Promise<{ signal: string | null }>((resolve) => c.once('exit', (_code, signal) => resolve({ signal })));

describe('killWithGrace', () => {
  it('ends a child that ignores SIGTERM with SIGKILL after the grace period', async () => {
    const c = await stubbornChild();
    const done = exited(c);
    const t0 = Date.now();
    killWithGrace(c, 300);
    const { signal } = await done;
    expect(signal).toBe('SIGKILL');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it('leaves a child that honours SIGTERM with SIGTERM and sends no SIGKILL', async () => {
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    live.push(c);
    const done = exited(c);
    killWithGrace(c, 5000);
    expect((await done).signal).toBe('SIGTERM');
  });

  it('does nothing for a child that already exited', async () => {
    const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    live.push(c);
    await exited(c);
    expect(() => killWithGrace(c, 50)).not.toThrow();
  });
});
