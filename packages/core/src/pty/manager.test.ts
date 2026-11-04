// packages/core/src/pty/manager.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { PTYManager } from './manager.js';

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return cond();
};

describe('PTYManager.kill', () => {
  const mgr = new PTYManager();
  const pids: number[] = [];
  afterEach(() => {
    mgr.killAll();
    for (const pid of pids.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } // a failed test must not leak the stubborn shell
  });

  it('ends a process that ignores SIGHUP and SIGTERM, with SIGKILL after the grace period', async () => {
    mgr.killGraceMs = 300;
    // The shell ignores both signals; "sleep" inherits the ignore and is the long-lived part.
    const pid = mgr.spawn('stubborn', '/bin/sh', ['-c', "trap '' HUP TERM; echo ready; while :; do sleep 1; done"], '/tmp');
    pids.push(pid);
    expect(await waitFor(() => mgr.getBuffer('stubborn').includes('ready'), 5000)).toBe(true);
    mgr.kill('stubborn');
    expect(mgr.isAlive('stubborn')).toBe(false);
    // Before the grace period ends the shell is still there (it ignored the hang-up).
    expect(alive(pid)).toBe(true);
    expect(await waitFor(() => !alive(pid), 5000)).toBe(true);
  });

  it('does not signal a process that already exited on its own', async () => {
    mgr.killGraceMs = 100;
    const pid = mgr.spawn('quick', '/bin/sh', ['-c', 'exit 0'], '/tmp');
    expect(await waitFor(() => !alive(pid), 5000)).toBe(true);
    expect(() => mgr.kill('quick')).not.toThrow();
  });

  it('a killed process that ends late does not evict or clear a replacement spawned under the same id', async () => {
    mgr.killGraceMs = 300;
    const oldPid = mgr.spawn('same-id', '/bin/sh', ['-c', "trap '' HUP TERM; echo ready; while :; do sleep 1; done"], '/tmp');
    pids.push(oldPid);
    expect(await waitFor(() => mgr.getBuffer('same-id').includes('ready'), 5000)).toBe(true);
    mgr.kill('same-id');
    const newPid = mgr.spawn('same-id', '/bin/sh', ['-c', 'echo second; while :; do sleep 1; done'], '/tmp');
    pids.push(newPid);
    const exits: number[] = [];
    mgr.on('exit', (_id: string, _code: number, pid: number) => exits.push(pid));
    // The old shell is killed by the grace timer and its exit callback fires.
    expect(await waitFor(() => !alive(oldPid), 5000)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(mgr.isAlive('same-id')).toBe(true);        // the replacement is still registered
    expect(alive(newPid)).toBe(true);
    expect(exits).not.toContain(newPid);
    expect(exits).not.toContain(oldPid); // the stale exit is dropped, not reported
  });
});
