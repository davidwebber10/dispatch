// packages/core/src/os/continuity.ts
// A hosted box restarts (image update, host maintenance, a crash) and the person must not see the
// machine. The pieces outside the boot kickstart (sessions/boot-recovery.ts):
//   • settleRestartedThreads: at boot, a thread left `working`/`needs_input` whose process did not
//     come back (a shell, a Grok/OpenCode chat, a thread nothing resumed) is set idle with a plain
//     activity line, never `error`: its process was replaced, nothing failed.
//   • POST /api/terminals/:id/continue: the "This thread was interrupted — Continue" card of a
//     harness that cannot resume a turn (Grok, OpenCode): clears the stamp and sends the continue prompt.
import type Database from 'better-sqlite3';
import type { Router } from 'express';
import { ownerOnlyStrict, policyRouter } from '../auth/route-policy.js';
import type { SessionService } from '../sessions/service.js';
import { ThreadConfigStore } from '../sessions/thread-config.js';
import * as terminalsDb from '../db/terminals.js';
import { CHAT_CONTINUE_PROMPT } from '../sessions/boot-recovery.js';

export const RESTART_ACTIVITY = 'Stopped by a restart';
export const INTERRUPTED_ACTIVITY = 'Interrupted by a restart — press Continue';

/** Settle every non-archived working/needs_input thread with no live process. Returns their ids. */
export function settleRestartedThreads(
  db: Database.Database,
  aliveOrWaiting: (id: string) => boolean,
  markIdle: (id: string, activity: string) => void,
): string[] {
  const rows = db.prepare("SELECT id, config FROM terminals WHERE archived_at IS NULL AND status IN ('working','needs_input')").all() as { id: string; config: string | null }[];
  const out: string[] = [];
  for (const r of rows) {
    if (aliveOrWaiting(r.id)) continue;
    let interrupted = false;
    try { interrupted = typeof JSON.parse(r.config || '{}').interruptedAt === 'string'; } catch { /* plain */ }
    markIdle(r.id, interrupted ? INTERRUPTED_ACTIVITY : RESTART_ACTIVITY);
    out.push(r.id);
  }
  return out;
}

export function createContinuityRouter(db: Database.Database, sessionService: SessionService): Router {
  const router = policyRouter();
  const store = new ThreadConfigStore(db);
  router.post('/terminals/:terminalId/continue', ownerOnlyStrict, (req, res) => {
    const id = req.params.terminalId;
    const row = terminalsDb.getById(db, id);
    if (!row || row.archived_at) return void res.status(404).json({ error: 'not found' });
    store.patch(id, { interruptedAt: null });
    try {
      sessionService.sendStructuredMessage(id, CHAT_CONTINUE_PROMPT);
    } catch (err) {
      return void res.status(409).json({ error: (err as Error)?.message ?? 'could not continue' });
    }
    res.status(204).end();
  });
  return router;
}
