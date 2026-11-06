import type { Router } from 'express';
import { policyRouter, ownerOnlyStrict } from '../auth/route-policy.js';
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import * as parksDb from '../db/usage-limits.js';
import { accountIdFor } from '../limits/account.js';
import type { LimitSnapshots } from '../limits/snapshot.js';
import { createCodexRefresh, type CodexRefresh, type CodexRefreshOpts } from '../limits/codex-refresh.js';
import { accountIdOf, type UsageSummary } from '../limits/gauge.js';

const REPORTING = new Set(['claude-code', 'codex']);

/**
 * GET /api/usage-limits?terminalId=… : the account's limit figures for the thread's provider, plus
 * the pause #106 put on this thread. Grok and OpenCode report no limits.
 */
export function createUsageLimitsRouter(db: Database.Database, snapshots: LimitSnapshots, opts: CodexRefreshOpts & {
  /** The daemon's shared refresher (the gauge tick uses it too, so the 30 s throttle holds for both). */
  refreshCodex?: CodexRefresh;
  /** The usage gauge's summary (#127). Without it `/usage-limits/summary` answers 503. */
  summary?: () => UsageSummary;
  /** Spend one of the account's banked limit resets (Codex only). The backend's outcome, or null. */
  useResetCredit?: (provider: string, creditId?: string, accountId?: string) => Promise<string | null>;
} = {}): Router {
  const accountFor = opts.accountFor ?? accountIdFor;
  const router = policyRouter();
  const refreshCodex = opts.refreshCodex ?? createCodexRefresh(snapshots, opts);

  /** GET /api/usage-limits/summary: the same body as the `usage-limits` broadcast, for a first load or a reconnect. */
  router.get('/usage-limits/summary', (_req, res) => {
    if (!opts.summary) { res.status(503).json({ error: 'usage gauge unavailable' }); return; }
    res.json(opts.summary());
  });

  /**
   * POST /api/usage-limits/reset-credit { provider, creditId? }: spend one banked limit reset
   * (2026-11-05): `creditId`, or the one that expires soonest.
   * It spends something of the account's, so only the owner may.
   * 200 { outcome: 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed' }, 502 when the
   * provider could not be asked, 400 for a provider without banked resets.
   */
  router.post('/usage-limits/reset-credit', ownerOnlyStrict, async (req, res) => {
    const provider = typeof req.body?.provider === 'string' ? req.body.provider : '';
    if (provider !== 'codex' || !opts.useResetCredit) { res.status(400).json({ error: 'this provider has no banked resets' }); return; }
    const creditId = typeof req.body?.creditId === 'string' && req.body.creditId ? req.body.creditId : undefined;
    const accountId = typeof req.body?.accountId === 'string' && req.body.accountId ? req.body.accountId : 'cli';
    const outcome = await opts.useResetCredit(provider, creditId, accountId);
    if (outcome === null) { res.status(502).json({ error: 'Codex could not be asked' }); return; }
    res.json({ outcome });
  });

  router.get('/usage-limits', (req, res) => {
    const id = typeof req.query.terminalId === 'string' ? req.query.terminalId : '';
    const term = id ? terminalsDb.getById(db, id) : null;
    if (!term) { res.status(404).json({ error: 'thread not found' }); return; }
    const provider = term.type;
    const supported = REPORTING.has(provider);
    const accountId = accountIdOf(term.config);
    if (provider === 'codex') refreshCodex(term.id, term.external_id, accountId);
    const park = parksDb.get(db, term.id);
    res.json({
      provider,
      accountId,
      supported,
      snapshot: supported ? snapshots.get(provider, accountFor(provider, accountId), accountId) : null,
      paused: park && park.state !== 'woken' ? { kind: park.kind, resetsAt: park.resets_at, capped: park.state === 'capped' } : null,
    });
  });
  return router;
}
