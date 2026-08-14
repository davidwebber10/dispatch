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
      if (!usage && !toolCalls) return;

      const open = usageDb.findOpenTurn(db, terminalId);
      if (!open) return; // a frame outside a turn is not attributable; drop it

      usageDb.addUsage(db, open.id, {
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        cacheRead: usage?.cacheRead ?? 0,
        cacheCreate: usage?.cacheCreate ?? 0,
        messages: usage ? 1 : 0,
        toolCalls,
      });
      if (usage?.model) usageDb.setModelIfEmpty(db, open.id, usage.model);
    } catch { /* best effort */ }
  });

  manager.on('idle', (terminalId: string) => close(terminalId, 'idle'));
  manager.on('needs-help', (terminalId: string) => close(terminalId, 'needs_help'));
  manager.on('scheduled', (terminalId: string) => close(terminalId, 'scheduled'));
  manager.on('exit', (terminalId: string) => close(terminalId, 'exit'));
}
