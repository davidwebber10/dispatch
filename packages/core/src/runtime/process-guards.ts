import { maxCrashLogsPerMinute, maxUncaughtPerMinute } from '../caps.js';

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

/** Never throws: an error object can have a getter that throws, and this runs where a throw ends the process. */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return String(err.stack || `${err.name}: ${err.message}`);
    return typeof err === 'string' ? err : JSON.stringify(err) ?? String(err);
  } catch {
    try { return String(err); } catch { return '(an error that could not be described)'; }
  }
}

export function installProcessGuards(deps: ProcessGuardDeps = {}): () => void {
  const proc = deps.proc ?? process;
  const rawLog = deps.log ?? ((l: string) => console.error(l));
  const log = (l: string) => { try { rawLog(l); } catch { /* a failing log must not end the process */ } };
  const now = deps.now ?? Date.now;
  const times: number[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();

  /** Log the first N reports in each minute; count the rest and say so once (when it starts, and in a summary). */
  const limited = (kind: string) => {
    let start = Number.NEGATIVE_INFINITY;
    let logged = 0;
    let suppressed = 0;
    const summary = () => {
      if (suppressed > 0) log(`[daemon] ${suppressed} more ${kind} in the last minute were not logged (limit ${maxCrashLogsPerMinute()} a minute; set DISPATCH_MAX_CRASH_LOGS_PER_MINUTE to change this).`);
      suppressed = 0;
    };
    return (build: () => string) => {
      const t = now();
      if (t - start >= WINDOW_MS) { summary(); start = t; logged = 0; }
      const n = maxCrashLogsPerMinute();
      if (n === 0 || logged < n) { logged++; log(build()); return; }
      if (suppressed++ === 0) {
        log(`[daemon] more than ${n} ${kind} in one minute: logging the rest as a count.`);
        // The count is written when the minute ends, even if nothing else throws.
        const timer = setTimeout(() => { timers.delete(timer); summary(); }, WINDOW_MS);
        timer.unref?.();
        timers.add(timer);
      }
    };
  };
  const logUncaught = limited('uncaught exceptions');
  const logRejection = limited('unhandled promise rejections');

  const onUncaught = (err: unknown, origin?: string) => {
    const limit = maxUncaughtPerMinute();
    let count = 0;
    if (limit > 0) {
      const t = now();
      times.push(t);
      while (times.length && t - times[0] > WINDOW_MS) times.shift();
      count = times.length;
    }
    const line = () => `[daemon] uncaught exception (${origin ?? 'uncaughtException'}); staying up.${count ? ` ${count} in the last minute.` : ''}\n${describeError(err)}`;
    // With an exit limit, the flood ends in an exit, so every report is logged. With no limit, rate-limit the log.
    if (limit > 0) log(line()); else logUncaught(line);
    if (limit > 0 && times.length > limit) {
      log(`[daemon] more than ${limit} uncaught exceptions in one minute: exiting so the supervisor restarts a clean daemon. Set DISPATCH_MAX_UNCAUGHT_PER_MINUTE to change this.`);
      proc.exit(1);
    }
  };
  const onRejection = (reason: unknown) => {
    logRejection(() => `[daemon] unhandled promise rejection; staying up.\n${describeError(reason)}`);
  };
  proc.on('uncaughtException', onUncaught);
  proc.on('unhandledRejection', onRejection);
  return () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    proc.off('uncaughtException', onUncaught);
    proc.off('unhandledRejection', onRejection);
  };
}
