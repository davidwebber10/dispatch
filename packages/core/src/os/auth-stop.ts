// packages/core/src/os/auth-stop.ts
// A thread whose CLI says "not logged in" or "login expired", and what happens to its process.
//
// Hosted box (wireStopOnAuthFailure): the process must not stay (~185 MB each, measured 2026-11-11). Once
// the failed turn has settled, the thread's process is stopped; the thread record stays, the chat shows the
// sign-in card, and the next message after sign-in starts the process again (the structured revive path,
// ensureStructuredAlive) and resumes the conversation.
//
// Local install (wireRestartOnAuthFailure): the process stays while the person is signed out, so the chat
// keeps its sign-in card (it lives in the memory of that process) and a view of the thread starts nothing.
// The NEXT MESSAGE to the thread replaces the process first (takeAuthRestart, called by the send path): a
// running `claude` holds the login it started with (an added account's token is in its env), so only a new
// process, resumed on the same conversation, sees the login the person has just made.
import type { IStructuredManager } from '../structured/manager.js';

/** Threads stopped here, until this time (ms). A short window: the exit of a stop arrives at once. */
const quietStops = new Map<string, number>();
const QUIET_MS = 2_000;

/** The caller is about to stop this thread's process on purpose (see isAuthStop). */
export function markAuthStop(terminalId: string): void { quietStops.set(terminalId, Date.now() + QUIET_MS); }

/**
 * True while a process that was stopped on purpose after a login failure is exiting. Its exit is not news:
 * the thread keeps the status the failed turn gave it (error, not done), and an open chat gets no
 * "Process exited" line after the sign-in card (status/service.ts markExited, ws/structured.ts).
 */
export function isAuthStop(terminalId: string): boolean {
  const until = quietStops.get(terminalId);
  if (until === undefined) return false;
  if (Date.now() > until) { quietStops.delete(terminalId); return false; }
  return true;
}

export interface AuthStopDeps {
  managers: Iterable<IStructuredManager>;
  stop: (terminalId: string) => void;
  /** Ask the CLI's login state again (the clean login caches `claude auth status`). */
  onAuthFailure?: () => void;
  /** Fallback when no `idle` follows the auth error. */
  delayMs?: number;
}

export function wireStopOnAuthFailure(deps: AuthStopDeps): () => void {
  const pending = new Map<string, NodeJS.Timeout>();
  const offs: Array<() => void> = [];
  const forget = (id: string) => {
    const t = pending.get(id);
    if (t === undefined) return false;
    clearTimeout(t);
    pending.delete(id);
    return true;
  };
  const stopNow = (id: string) => {
    if (!forget(id)) return;
    markAuthStop(id);
    try { deps.stop(id); } catch { quietStops.delete(id); /* the thread may be gone */ }
  };
  for (const m of deps.managers) {
    const onAuth = (id: string) => {
      try { deps.onAuthFailure?.(); } catch { /* best effort */ }
      if (pending.has(id)) return;
      const t = setTimeout(() => stopNow(id), deps.delayMs ?? 10_000);
      t.unref?.();
      pending.set(id, t);
    };
    // The turn that failed has ended (Claude says `failed`, others `idle`): stop now, after the settle
    // listeners ran.
    const onEnd = (id: string) => { if (pending.has(id)) setImmediate(() => stopNow(id)); };
    // The failed process ended on its own, or the thread moved to a new one (Switch account, a restart):
    // the stop that waits was meant for the old process and must not reach the new one.
    const onExit = (id: string) => { forget(id); };
    m.on('auth-required', onAuth);
    m.on('idle', onEnd);
    m.on('failed', onEnd);
    m.on('exit', onExit);
    offs.push(() => { m.off('auth-required', onAuth); m.off('idle', onEnd); m.off('failed', onEnd); m.off('exit', onExit); });
  }
  return () => { for (const o of offs) o(); for (const t of pending.values()) clearTimeout(t); pending.clear(); };
}

/** Threads whose last turn failed on the login and whose process is still alive (local install). */
const needsFreshProcess = new Set<string>();

/**
 * True once for a thread that failed on its login since its process started: the caller then replaces the
 * process before it delivers the message. The stop is marked quiet (the thread keeps its status, the chat
 * gets no "Process exited" line).
 */
export function takeAuthRestart(terminalId: string): boolean {
  if (!needsFreshProcess.delete(terminalId)) return false;
  markAuthStop(terminalId);
  return true;
}

/** Remember which threads failed on their login. Only the Claude manager is given: the others share a process or hold no env login. */
export function wireRestartOnAuthFailure(managers: Iterable<IStructuredManager>): () => void {
  const offs: Array<() => void> = [];
  for (const m of managers) {
    const onAuth = (id: string) => { needsFreshProcess.add(id); };
    // A turn that worked proves the login works again; a process that ended takes its login with it.
    const onClear = (id: string) => { needsFreshProcess.delete(id); };
    m.on('auth-required', onAuth);
    m.on('idle', onClear);
    m.on('exit', onClear);
    offs.push(() => { m.off('auth-required', onAuth); m.off('idle', onClear); m.off('exit', onClear); });
  }
  return () => { for (const o of offs) o(); needsFreshProcess.clear(); };
}
