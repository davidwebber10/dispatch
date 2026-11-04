// packages/core/src/platform/kill-grace.ts
import type { ChildProcess } from 'child_process';

/** How long a stopped CLI gets to end after SIGTERM before it is killed outright. */
export const KILL_GRACE_MS = 3000;

/**
 * Stop a child process: SIGTERM first, then SIGKILL if it is still running after `graceMs`.
 * A CLI that ignores SIGTERM (a hung one, or one with a handler that never exits) would
 * otherwise outlive the thread that owned it. The timer never keeps the daemon alive, and it
 * is dropped when the child exits, so a reused pid is never signalled.
 * It stops the child only, not the processes the child started.
 */
export function killWithGrace(child: ChildProcess, graceMs: number = KILL_GRACE_MS): void {
  try { child.kill(); } catch { /* already gone */ }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, graceMs);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}
