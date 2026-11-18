// packages/core/src/os/approvals-routes.ts
// The approvals of a chat thread (os/approvals.ts) and its blocked-action cards:
//   GET  /api/terminals/:id/approvals            { mode, blocked[], pending }  (pending: the gated tool waiting now)
//   POST /api/terminals/:id/approvals            { mode: 'auto'|'ask'|'smart' } — saved, and applied live when running
//   POST /api/terminals/:id/blocked/:blockId     { decision: 'allow'|'keep' }  — "Allow this" / "Keep blocked"
// The page re-reads GET after a reload or a reconnect, so a waiting card is never lost.
import type { Router } from 'express';
import { ownerOnly, ownerOnlyStrict, policyRouter } from '../auth/route-policy.js';
import type { SessionService } from '../sessions/service.js';
import { ThreadConfigStore } from '../sessions/thread-config.js';
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import { approvalsFor, isApprovals, type Approvals } from './approvals.js';
import { currentProfile } from './profile.js';

export function createApprovalsRouter(db: Database.Database, sessionService: SessionService): Router {
  const router = policyRouter();
  const store = new ThreadConfigStore(db);
  const configOf = (id: string): Record<string, unknown> | null => {
    const row = terminalsDb.getById(db, id);
    if (!row) return null;
    try { return JSON.parse(row.config || '{}'); } catch { return {}; }
  };
  /** The mode the page shows: the saved one, the profile default, else what the legacy autonomy means. */
  const modeOf = (config: Record<string, unknown>): Approvals =>
    approvalsFor(config, currentProfile()) ?? (config.role === 'agent' && config.autonomy === 'supervised' ? 'ask' : 'auto');

  router.get('/terminals/:terminalId/approvals', ownerOnly, (req, res) => {
    const id = req.params.terminalId;
    const config = configOf(id);
    if (!config) return void res.status(404).json({ error: 'not found' });
    const manager = sessionService.structuredManagerForTerminal(id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ mode: modeOf(config), blocked: manager?.getBlocked?.(id) ?? [], pending: sessionService.getPendingPermission(id) ?? null });
  });

  router.post('/terminals/:terminalId/approvals', ownerOnlyStrict, async (req, res) => {
    const id = req.params.terminalId;
    const mode = req.body?.mode;
    if (!isApprovals(mode)) return void res.status(400).json({ error: "mode must be 'auto', 'ask' or 'smart'" });
    const config = configOf(id);
    if (!config) return void res.status(404).json({ error: 'not found' });
    if (config.role === 'coordinator') return void res.status(400).json({ error: 'An overseer keeps its own rules.' });
    store.patch(id, { approvals: mode });
    const manager = sessionService.structuredManagerForTerminal(id);
    if (manager?.isAlive(id) && manager.setApprovals) {
      try { await manager.setApprovals(id, mode); } catch (err) { return void res.json({ mode, live: false, note: (err as Error)?.message ?? 'applies at the next start' }); }
      return void res.json({ mode, live: true });
    }
    res.json({ mode, live: false });
  });

  router.post('/terminals/:terminalId/blocked/:blockId', ownerOnlyStrict, async (req, res) => {
    const { terminalId, blockId } = req.params;
    const decision = req.body?.decision;
    if (decision !== 'allow' && decision !== 'keep') return void res.status(400).json({ error: "decision must be 'allow' or 'keep'" });
    const manager = sessionService.structuredManagerForTerminal(terminalId);
    const ok = manager?.resolveBlocked ? await manager.resolveBlocked(terminalId, blockId, decision) : false;
    if (!ok) return void res.status(404).json({ error: 'no blocked action with that id' });
    res.status(204).end();
  });

  return router;
}
