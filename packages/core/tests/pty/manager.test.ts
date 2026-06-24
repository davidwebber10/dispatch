import { describe, it, expect } from 'vitest';
import os from 'os';
import { PTYManager } from '../../src/pty/manager.js';

/**
 * Integration test: drives a real PTY through node-pty so the spawn → data →
 * exit wiring in PTYManager is exercised against the actual native addon.
 * This is the regression guard for the node-pty 0.10.x → 1.x migration
 * (the `.on('data')`/`.on('exit')` → `.onData`/`.onExit` API change).
 */
describe('PTYManager (real PTY)', () => {
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
});
