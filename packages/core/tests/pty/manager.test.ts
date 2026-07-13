import { describe, it, expect } from 'vitest';
import os from 'os';
import { PTYManager } from '../../src/pty/manager.js';

/**
 * Integration test: drives a real PTY through node-pty so the spawn → data →
 * exit wiring in PTYManager is exercised against the actual native addon.
 * This is the regression guard for the node-pty 0.10.x → 1.x migration
 * (the `.on('data')`/`.on('exit')` → `.onData`/`.onExit` API change).
 *
 * The real-PTY test spawns /bin/sh which does not exist on Windows.
 * Windows PTY bring-up is confirmed separately via ConPTY during bring-up.
 */
describe.skipIf(process.platform === 'win32')('PTYManager (real PTY)', () => {
  it('streams process output and reports the exit code', async () => {
    const manager = new PTYManager();
    const chunks: string[] = [];

    manager.on('data', (_sessionId: string, data: string) => {
      chunks.push(data);
    });

    const exited = new Promise<number>((resolve) => {
      manager.on('exit', (_sessionId: string, exitCode: number) => resolve(exitCode));
    });

    // Print a known marker, then exit with a distinctive non-zero code.
    const pid = manager.spawn('sess-1', '/bin/sh', ['-c', 'printf MARKER; exit 7'], os.tmpdir());
    expect(pid).toBeGreaterThan(0);

    const exitCode = await exited;

    expect(chunks.join('')).toContain('MARKER');
    expect(exitCode).toBe(7);
    // PTY should be reaped from the live set once it exits.
    expect(manager.isAlive('sess-1')).toBe(false);
  }, 10_000);

  it('nudgeRepaint wiggles the PTY size (SIGWINCH) and restores it', async () => {
    const manager = new PTYManager();
    const chunks: string[] = [];
    manager.on('data', (_id: string, data: string) => chunks.push(data));

    // A shell that reports every SIGWINCH it receives.
    manager.spawn('sess-w', '/bin/sh', ['-c', 'trap "echo GOT-WINCH" WINCH; while :; do sleep 0.05; done'], os.tmpdir());
    await new Promise((r) => setTimeout(r, 300)); // let the trap install
    manager.resize('sess-w', 100, 40);
    await new Promise((r) => setTimeout(r, 200));
    chunks.length = 0;

    manager.nudgeRepaint('sess-w');
    await new Promise((r) => setTimeout(r, 500));

    // Two size changes → two SIGWINCHes (wiggle out + restore).
    const winches = chunks.join('').match(/GOT-WINCH/g) ?? [];
    expect(winches.length).toBeGreaterThanOrEqual(2);
    manager.kill('sess-w');
  }, 10_000);

  it('nudgeRepaint skips the restore when a client resize lands mid-wiggle', async () => {
    const manager = new PTYManager();
    manager.spawn('sess-r', '/bin/sh', ['-c', 'while :; do sleep 0.05; done'], os.tmpdir());
    manager.resize('sess-r', 100, 40);
    await new Promise((r) => setTimeout(r, 100));

    manager.nudgeRepaint('sess-r');
    manager.resize('sess-r', 90, 30); // a viewer's fit arrives before the restore timer
    await new Promise((r) => setTimeout(r, 400));

    // The restore must NOT clobber the client's size back to 100x40.
    expect(manager.getSize('sess-r')).toEqual({ cols: 90, rows: 30 });
    manager.kill('sess-r');
  }, 10_000);
});
