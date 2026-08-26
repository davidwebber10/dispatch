import { randomUUID } from 'crypto';
import type { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import * as usageDb from '../db/usage.js';
import * as terminalsDb from '../db/terminals.js';
import { usageFromFrame, toolCallsInFrame } from './frames.js';

export interface RecorderDeps {
  db: Database.Database;
  /** Injectable clock, so tests do not depend on wall time. */
  now?: () => string;
  /** Called after a turn row closes, so the server can broadcast a refresh hint. */
  onTurnClosed?: () => void;
}

/**
 * Record one row per structured turn, live, from the events the manager already
 * emits (server.ts:118-175 wires the same ones for status).
 *
 * Deliberately NOT hung off sessionService.noteAgentCompletion: that returns early
 * on `cfg.role !== 'agent'` (service.ts:1117), so it never runs for ordinary chat
 * threads and half the usage would vanish. The manager's own events fire for every
 * structured thread.
 *
 * Every handler is best-effort. Analytics must never break a turn.
 */
/**
 * The subtypes whose result-footer `total_cost_usd` is a translator-computed
 * PER-TURN delta (grok-translate.ts takeCostDelta), safe to sum row by row.
 * Claude's own result footer also carries `total_cost_usd`, but that figure is
 * session-cumulative — summing it per turn would multiply the real number, so
 * everything outside this set is ignored. Claude turns are valued from their
 * tokens by pricing.ts instead.
 */
const PER_TURN_COST_SUBTYPES: ReadonlySet<string> = new Set(['acp_turn', 'grok_turn']);

function reportedCostFromFrame(ev: unknown): number {
  if (!ev || typeof ev !== 'object') return 0;
  const rec = ev as Record<string, unknown>;
  if (rec.type !== 'result' || typeof rec.subtype !== 'string' || !PER_TURN_COST_SUBTYPES.has(rec.subtype)) return 0;
  return typeof rec.total_cost_usd === 'number' && Number.isFinite(rec.total_cost_usd) && rec.total_cost_usd > 0
    ? rec.total_cost_usd : 0;
}

export function attachUsageRecorder(manager: EventEmitter, deps: RecorderDeps): void {
  const { db, onTurnClosed } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  const close = (terminalId: string, outcome: string): void => {
    try {
      const open = usageDb.findOpenTurn(db, terminalId);
      if (!open) return;
      usageDb.closeTurn(db, open.id, now(), outcome);
      onTurnClosed?.();
    } catch { /* best effort */ }
  };

  manager.on('busy', (terminalId: string) => {
    try {
      // A turn that never settled (a resume over a live turn) is closed first, so
      // one terminal can never hold two open rows.
      const stale = usageDb.findOpenTurn(db, terminalId);
      if (stale) usageDb.closeTurn(db, stale.id, now(), 'interrupted');

      const terminal = terminalsDb.getById(db, terminalId);
      if (!terminal) return;
      let cfg: Record<string, any> = {};
      try { cfg = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }

      usageDb.openTurn(db, {
        id: randomUUID(),
        terminalId,
        projectId: terminal.session_id,
        provider: terminal.type,
        model: typeof cfg.model === 'string' ? cfg.model : '',
        role: typeof cfg.role === 'string' ? cfg.role : '',
        startedAt: now(),
      });
    } catch { /* best effort */ }
  });

  manager.on('event', (terminalId: string, ev: unknown) => {
    try {
      const usage = usageFromFrame(ev);
      const toolCalls = toolCallsInFrame(ev);
      const costUsd = reportedCostFromFrame(ev);
      if (!usage && !toolCalls && !costUsd) return;

      const open = usageDb.findOpenTurn(db, terminalId);
      if (!open) return; // a frame outside a turn is not attributable; drop it

      if (costUsd) usageDb.addCost(db, open.id, costUsd);
      if (!usage && !toolCalls) return;

      usageDb.addUsage(db, open.id, {
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        cacheRead: usage?.cacheRead ?? 0,
        cacheCreate: usage?.cacheCreate ?? 0,
        messages: usage ? 1 : 0,
        toolCalls,
      });
      // The frame's model is AUTHORITATIVE. The row opened with
      // `terminal.config.model`, which sessions/service.ts persists as
      // modelFor(config) — a bare CLI tier alias ('sonnet', 'opus', 'haiku',
      // 'fable'), which priceFor() cannot price and which splits one model across
      // two chart keys. Codex is unaffected: its frames never name a model
      // (codex-translate.ts names one only in `init`, which carries no usage), so
      // the guard below never fires and its slug from config survives.
      if (usage?.model) usageDb.setModel(db, open.id, usage.model);
    } catch { /* best effort */ }
  });

  manager.on('idle', (terminalId: string) => close(terminalId, 'idle'));
  manager.on('needs-help', (terminalId: string) => close(terminalId, 'needs_help'));
  manager.on('scheduled', (terminalId: string) => close(terminalId, 'scheduled'));
  manager.on('exit', (terminalId: string) => close(terminalId, 'exit'));
}

/**
 * Close every row left open by a daemon that died mid-turn. `ended_at` is set to
 * `started_at`, not to now: the turn's real end is unknown, and a multi-hour
 * phantom duration would poison every duration statistic. Called once at startup.
 */
export function closeInterruptedTurns(db: Database.Database): number {
  try {
    return db.prepare(`
      UPDATE usage_turns SET ended_at = started_at, outcome = 'interrupted'
      WHERE ended_at IS NULL
    `).run().changes;
  } catch {
    return 0;
  }
}
