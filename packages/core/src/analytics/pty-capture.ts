import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import * as sessionsDb from '../db/sessions.js';
import * as ptyDb from '../db/usage-pty.js';
import type { PtyStateRow } from '../db/usage-pty.js';
import type { ClosedTurnInput } from '../db/usage.js';
import { readClaudeTail } from './pty-claude.js';
import { locateCodexTranscript } from './codex-locate.js';
import { readCodexTail } from './codex-frames.js';
import { resolveTranscriptPath } from '../sessions/transcript-path.js';
import type { SettledListener } from '../status/service.js';

export interface PtyCaptureDeps {
  db: Database.Database;
  /**
   * The double-count gate. `StatusService` fires the settled edge for BOTH
   * transports — `markIdle()` (the structured path) calls the same `apply()`
   * that fires this listener, and a structured thread is already recorded,
   * frame by frame, by the live recorder (analytics/recorder.ts). Returning
   * here for a structured terminal is what keeps every structured turn from
   * getting a second row on top of the live one.
   */
  isStructured: (terminalId: string) => boolean;
  /** Injectable clock, so tests do not depend on wall time. */
  now?: () => string;
  /** Called after a turn row closes, so the server can broadcast a refresh hint. */
  onTurnClosed?: () => void;
}

/**
 * Record one row per PTY turn, on the turn-settled edge, by diffing the
 * provider's own transcript against the last position/total we saw.
 *
 * Returns the listener rather than subscribing itself — server.ts decides
 * where (and whether) to attach it, and a test can drive it directly.
 *
 * Every branch lives inside one try/catch: analytics must never break a turn.
 */
export function attachPtyCapture(deps: PtyCaptureDeps): SettledListener {
  const { db, onTurnClosed } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  return ({ terminalId, threadStatus }) => {
    try {
      // 1. GATE. A structured thread is already covered by the live recorder.
      if (deps.isStructured(terminalId)) return;

      const terminal = terminalsDb.getById(db, terminalId);
      if (!terminal) return;

      // A provider that is neither claude-code nor codex (grok, shell) records nothing.
      if (terminal.type !== 'claude-code' && terminal.type !== 'codex') return;

      const projectId = terminal.session_id;
      const provider = terminal.type;
      let cfg: Record<string, any> = {};
      try { cfg = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
      const role = typeof cfg.role === 'string' ? cfg.role : '';
      const outcome = threadStatus === 'needs_input' ? 'needs_help' : 'idle';
      const nowStr = now();
      const priorState = ptyDb.getState(db, terminalId);

      if (provider === 'claude-code') {
        let workDir = terminal.working_dir || '';
        if (!workDir) {
          const session = sessionsDb.getById(db, terminal.session_id);
          workDir = session?.working_dir || '';
        }
        const file = resolveTranscriptPath(workDir, terminal.external_id || '');
        if (!file) return;

        // Relocation: the resolved path differs from the stored one. A byte offset
        // from another file is meaningless — treat the new file as fresh, write no row.
        if (priorState && priorState.transcript_path !== file) {
          const fresh = readClaudeTail(file, 0);
          if (!fresh) return;
          ptyDb.putState(db, {
            terminal_id: terminalId,
            transcript_path: file,
            byte_offset: fresh.nextOffset,
            last_total_input: 0,
            last_total_output: 0,
            last_total_cached: 0,
            updated_at: nowStr,
          });
          return;
        }

        const fromOffset = priorState?.byte_offset ?? 0;
        const tail = readClaudeTail(file, fromOffset);
        if (!tail) return;

        if (!priorState) {
          // Bootstrap at the END, never at zero: a first-sight thread records its
          // current position and writes no row.
          ptyDb.putState(db, {
            terminal_id: terminalId,
            transcript_path: file,
            byte_offset: tail.nextOffset,
            last_total_input: 0,
            last_total_output: 0,
            last_total_cached: 0,
            updated_at: nowStr,
          });
          return;
        }

        const row: ClosedTurnInput = {
          id: randomUUID(),
          terminalId,
          projectId,
          provider,
          model: tail.model,
          role,
          startedAt: priorState.updated_at,
          endedAt: nowStr,
          outcome,
          input: tail.input,
          output: tail.output,
          cacheRead: tail.cacheRead,
          cacheCreate: tail.cacheCreate,
          messages: tail.messages,
          toolCalls: tail.toolCalls,
          backfilled: false,
        };
        const nextState: PtyStateRow = {
          terminal_id: terminalId,
          transcript_path: file,
          byte_offset: tail.nextOffset,
          last_total_input: 0,
          last_total_output: 0,
          last_total_cached: 0,
          updated_at: nowStr,
        };
        ptyDb.recordTurn(db, row, nextState);
        onTurnClosed?.();
        return;
      }

      // provider === 'codex'
      const file = locateCodexTranscript(terminal.external_id || '');
      if (!file) return;

      const tail = readCodexTail(file);
      if (!tail || !tail.totals) return;

      if (!priorState) {
        // Bootstrap at the END: a first-sight thread records its current running
        // total and writes no row.
        ptyDb.putState(db, {
          terminal_id: terminalId,
          transcript_path: file,
          byte_offset: 0,
          last_total_input: tail.totals.input,
          last_total_output: tail.totals.output,
          last_total_cached: tail.totals.cached,
          updated_at: nowStr,
        });
        return;
      }

      const dInput = tail.totals.input - priorState.last_total_input;
      const dOutput = tail.totals.output - priorState.last_total_output;
      const dCached = tail.totals.cached - priorState.last_total_cached;

      const nextState: PtyStateRow = {
        terminal_id: terminalId,
        transcript_path: file,
        byte_offset: 0,
        last_total_input: tail.totals.input,
        last_total_output: tail.totals.output,
        last_total_cached: tail.totals.cached,
        updated_at: nowStr,
      };

      // Guard: a negative diff means the total reset in a way nobody has observed.
      // Never write a negative row — record zero and reset the stored totals.
      const reset = dInput < 0 || dOutput < 0 || dCached < 0;

      const row: ClosedTurnInput = {
        id: randomUUID(),
        terminalId,
        projectId,
        provider,
        model: tail.model,
        role,
        startedAt: priorState.updated_at,
        endedAt: nowStr,
        outcome,
        input: reset ? 0 : dInput - dCached,
        output: reset ? 0 : dOutput,
        cacheRead: reset ? 0 : dCached,
        cacheCreate: 0,
        messages: reset ? 0 : 1,
        toolCalls: 0,
        backfilled: false,
      };
      ptyDb.recordTurn(db, row, nextState);
      onTurnClosed?.();
    } catch { /* analytics must never break a turn */ }
  };
}
