// packages/core/src/os/auth-stop.ts
// A hosted box: a chat thread whose CLI says "not logged in" must not keep its process (~185 MB each,
// measured 2026-11-11). Once the failed turn has settled, the thread's process is stopped; the thread
// record stays, the chat shows the sign-in card, and the next message after sign-in starts the
// process again (the structured revive path, ensureStructuredAlive) and resumes the conversation.
import type { IStructuredManager } from '../structured/manager.js';

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
  const stopNow = (id: string) => {
    const t = pending.get(id);
    if (t === undefined) return;
    clearTimeout(t);
    pending.delete(id);
    try { deps.stop(id); } catch { /* the thread may be gone */ }
  };
  for (const m of deps.managers) {
    const onAuth = (id: string) => {
      try { deps.onAuthFailure?.(); } catch { /* best effort */ }
      if (pending.has(id)) return;
      const t = setTimeout(() => stopNow(id), deps.delayMs ?? 10_000);
      t.unref?.();
      pending.set(id, t);
    };
    // The turn that failed has ended: stop now, after the settle listeners ran.
    const onIdle = (id: string) => { if (pending.has(id)) setImmediate(() => stopNow(id)); };
    m.on('auth-required', onAuth);
    m.on('idle', onIdle);
    offs.push(() => { m.off('auth-required', onAuth); m.off('idle', onIdle); });
  }
  return () => { for (const o of offs) o(); for (const t of pending.values()) clearTimeout(t); pending.clear(); };
}
