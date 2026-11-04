import { maxUncaughtPerMinute } from '../caps.js';

/**
 * Last-resort handlers for errors nothing caught (SEC-23).
 *
 * Behavior: LOG and STAY UP. The daemon holds every live agent thread as a child process; if it exits, all of those
 * threads die with it. launchd restarts it on macOS (KeepAlive), but the WSL scheduled task does not, and a restart
 * still ends running turns. One stray error in a timer or a socket callback is not worth that.
 *
 * Crash-loop breaker: more than DISPATCH_MAX_UNCAUGHT_PER_MINUTE (default 10) uncaught errors inside one minute means
 * the process is in a bad state, so it exits non-zero and the supervisor starts a clean one. 0 turns the breaker off.
 * A rejected promise that nothing awaited is logged only; it never counts toward the breaker.
 */
export interface ProcessGuardDeps {
  proc?: Pick<NodeJS.Process, 'on' | 'off' | 'exit'>;
  log?: (line: string) => void;
  now?: () => number;
}

const WINDOW_MS = 60_000;

function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  try { return typeof err === 'string' ? err : JSON.stringify(err); } catch { return String(err); }
}

export function installProcessGuards(deps: ProcessGuardDeps = {}): () => void {
  const proc = deps.proc ?? process;
  const log = deps.log ?? ((l: string) => console.error(l));
  const now = deps.now ?? Date.now;
  const times: number[] = [];

  const onUncaught = (err: unknown, origin?: string) => {
    const t = now();
    times.push(t);
    while (times.length && t - times[0] > WINDOW_MS) times.shift();
    const limit = maxUncaughtPerMinute();
    log(`[daemon] uncaught exception (${origin ?? 'uncaughtException'}); staying up. ${times.length} in the last minute.\n${describeError(err)}`);
    if (limit > 0 && times.length > limit) {
      log(`[daemon] more than ${limit} uncaught exceptions in one minute: exiting so the supervisor restarts a clean daemon. Set DISPATCH_MAX_UNCAUGHT_PER_MINUTE to change this.`);
      proc.exit(1);
    }
  };
  const onRejection = (reason: unknown) => {
    log(`[daemon] unhandled promise rejection; staying up.\n${describeError(reason)}`);
  };
  proc.on('uncaughtException', onUncaught);
  proc.on('unhandledRejection', onRejection);
  return () => {
    proc.off('uncaughtException', onUncaught);
    proc.off('unhandledRejection', onRejection);
  };
}
