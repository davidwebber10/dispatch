import { randomUUID } from 'crypto';
import fs from 'fs';
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
 * NO DURATION. Every row this writes sets `started_at` equal to `ended_at`, so it
 * contributes no duration at all. Capture only ever runs on the settled edge, so
 * the one timestamp it owns is the END of a turn. The previous settle — the only
 * other timestamp available — is when the LAST turn ended, so the span between
 * them is mostly the user reading and typing, not the model working. Using it
 * would give a thread left open overnight a multi-hour "turn" that lands in
 * AVG(duration) and reads out as the headline longestTurnSeconds. The live
 * recorder has a genuine start (the manager's `busy` event); a PTY reader does
 * not, and honest absence beats a plausible wrong number. This is the same answer
 * importer.ts gives for a backfilled row, and queries.ts already excludes
 * `ended_at == started_at` from every duration query for exactly this reason.
 *
 * Every branch lives inside one try/catch: analytics must never break a turn.
 */
export function attachPtyCapture(deps: PtyCaptureDeps): SettledListener {
  const { db, onTurnClosed } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  return ({ terminalId, threadStatus }) => {
    try {
      // 1. GATE. A structured thread is already covered by the live recorder.
      // Also clear any stored PTY capture state: a terminal's transport can flip
      // WITHOUT a new terminal id (SessionService.switchTransport re-spawns onto
      // the same external_id, in both directions; DISPATCH_CODEX_PRETTY can also
      // flip what isStructured returns for a Codex row without touching config
      // at all). While a thread is structured the live recorder owns it, so a
      // stored cursor/total is meaningless — and if left in place, the next PTY
      // settle after a flip-back would diff/read from BEFORE the structured
      // period and re-count everything the live recorder already wrote for it.
      // Deleting is self-healing: the next PTY settle finds no prior state and
      // bootstraps fresh, exactly like a first-sight thread.
      if (deps.isStructured(terminalId)) {
        ptyDb.deleteState(db, terminalId);
        return;
      }

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
        // Only the size is needed here, so stat the file directly rather than parsing
        // its whole content through readClaudeTail — this runs on the settled edge.
        if (priorState && priorState.transcript_path !== file) {
          let size: number;
          try { size = fs.statSync(file).size; } catch { return; }
          ptyDb.putState(db, {
            terminal_id: terminalId,
            transcript_path: file,
            byte_offset: size,
            last_total_input: 0,
            last_total_output: 0,
            last_total_cached: 0,
            updated_at: nowStr,
          });
          return;
        }

        if (!priorState) {
          // Bootstrap at the END, never at zero: a first-sight thread records its
          // current position and writes no row. Only the size is needed here, so
          // stat the file directly rather than parsing the whole transcript
          // through readClaudeTail — this runs on the settled edge.
          let size: number;
          try { size = fs.statSync(file).size; } catch { return; }
          ptyDb.putState(db, {
            terminal_id: terminalId,
            transcript_path: file,
            byte_offset: size,
            last_total_input: 0,
            last_total_output: 0,
            last_total_cached: 0,
            updated_at: nowStr,
          });
          return;
        }

        const tail = readClaudeTail(file, priorState.byte_offset);
        if (!tail) return;

        // Truncation: readClaudeTail resets to 0 and returns the WHOLE file when the
        // file is shorter than our cursor (pty-claude.ts's compaction guard). That is
        // correct for a pure reader; the honest response here is the same as
        // relocation — the file we were tracking no longer exists in the form we
        // tracked it, so bootstrap at the new end and write no row. Otherwise the
        // whole file lands in one turn and re-counts everything already recorded.
        if (tail.nextOffset < priorState.byte_offset) {
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
          startedAt: nowStr, // == endedAt: no duration. See NO DURATION below.
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

      // File switch: a resumed session, or the archived-vs-active pair, can point
      // the locator at a DIFFERENT rollout file whose totals restart low. The
      // negative-diff guard below would stop that corrupting the counts, but the
      // honest behaviour is the same as Claude's relocation case — bootstrap fresh
      // against the new file and write no row, rather than a spurious zero-token row.
      if (priorState && priorState.transcript_path !== file) {
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
        startedAt: nowStr, // == endedAt: no duration. See NO DURATION below.
        endedAt: nowStr,
        outcome,
        input: reset ? 0 : Math.max(0, dInput - dCached),
        output: reset ? 0 : dOutput,
        cacheRead: reset ? 0 : dCached,
        cacheCreate: 0,
        // `messages` is NOT a count here — it is the flag queries.ts reads as
        // `SUM(CASE WHEN messages = 0 ...)` to report "N turns reported no usage".
        // A turn whose running total did not move is a turn we FAILED to measure
        // (a duplicate token_count emission, an event before turn_aborted, a
        // post-compaction event), not a turn that genuinely cost nothing. Marking
        // it 1 would publish a measured zero — the exact silence unreportedTurns
        // was added to prevent. Only a moved total earns the "reported" flag.
        messages: (!reset && (dInput || dOutput || dCached)) ? 1 : 0,
        toolCalls: 0,
        backfilled: false,
      };
      ptyDb.recordTurn(db, row, nextState);
      onTurnClosed?.();
    } catch { /* analytics must never break a turn */ }
  };
}
