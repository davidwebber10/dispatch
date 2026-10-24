import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import * as parksDb from '../db/usage-limits.js';
import { locateCodexTranscript } from '../analytics/codex-locate.js';
import { readCodexRateLimits } from '../analytics/codex-frames.js';
import { accountIdFor } from '../limits/account.js';
import { parseCodexRateLimits, type LimitSnapshots } from '../limits/snapshot.js';

const REPORTING = new Set(['claude-code', 'codex']);
const CODEX_REFRESH_MS = 30_000;

/**
 * GET /api/usage-limits?terminalId=… : the account's limit figures for the thread's provider, plus
 * the pause #106 put on this thread. Grok and OpenCode report no limits.
 */
export function createUsageLimitsRouter(db: Database.Database, snapshots: LimitSnapshots, now: () => number = Date.now): Router {
  const router = Router();
  const lastRead = new Map<string, number>();

  /** Codex writes its limits into the session file; read the newest at most every 30 s per thread. */
  const refreshCodex = (terminalId: string, externalId: string | null): void => {
    const t = now();
    if (!externalId || t - (lastRead.get(terminalId) ?? 0) < CODEX_REFRESH_MS) return;
    lastRead.set(terminalId, t);
    const file = locateCodexTranscript(externalId);
    const found = file ? readCodexRateLimits(file) : null;
    if (!found) return;
    const { windows, plan } = parseCodexRateLimits(found.rateLimits);
    snapshots.record('codex', accountIdFor('codex'), windows, found.at || t, plan);
  };

  router.get('/usage-limits', (req, res) => {
    const id = typeof req.query.terminalId === 'string' ? req.query.terminalId : '';
    const term = id ? terminalsDb.getById(db, id) : null;
    if (!term) { res.status(404).json({ error: 'thread not found' }); return; }
    const provider = term.type;
    const supported = REPORTING.has(provider);
    if (provider === 'codex') refreshCodex(term.id, term.external_id);
    const park = parksDb.get(db, term.id);
    res.json({
      provider,
      supported,
      snapshot: supported ? snapshots.get(provider, accountIdFor(provider)) : null,
      paused: park && park.state !== 'woken' ? { kind: park.kind, resetsAt: park.resets_at, capped: park.state === 'capped' } : null,
    });
  });
  return router;
}
