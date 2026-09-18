import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import * as sessionsDb from '../db/sessions.js';
import * as ptyDb from '../db/usage-pty.js';
import * as usageDb from '../db/usage.js';
import { recordMeasurement } from '../db/telemetry.js';
import { readClaudeTail } from './pty-claude.js';
import { locateCodexTranscript } from './codex-locate.js';
import { readCodexTail } from './codex-frames.js';
import { resolveTranscriptPath } from '../sessions/transcript-path.js';
import type { TurnBoundaryListener } from '../status/service.js';
import { AGENT_TYPES, isAgentType } from '../providers/agent-types.js';
import { getProvider } from '../providers/registry.js';

export interface PtyCaptureDeps {
  db: Database.Database;
  isStructured: (terminalId: string) => boolean;
  now?: () => string;
  onTurnClosed?: () => void;
}
export const PTY_CAPTURE_STRATEGY = Object.fromEntries(AGENT_TYPES.map((type) => [type, getProvider(type).telemetry.ptyCapture]));

/** Explicit turn boundaries, independent of display status and permission pauses. */
export function attachPtyCapture(deps: PtyCaptureDeps): TurnBoundaryListener {
  const { db } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  return ({ terminalId, phase, threadStatus, nativeTurnId }) => {
    if (deps.isStructured(terminalId)) { ptyDb.deleteState(db, terminalId); return; }
    const terminal = terminalsDb.getById(db, terminalId);
    if (!terminal || !isAgentType(terminal.type)) return;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(terminal.config || '{}'); } catch { /* default */ }
    if (cfg.runner) return; // AgentService owns the runner's structured stream.
    const strategy = getProvider(terminal.type).telemetry.ptyCapture;
    const sessionId = terminal.external_id ?? '';
    const workDir = terminal.working_dir || sessionsDb.getById(db, terminal.session_id)?.working_dir || '';
    const file = strategy === 'claude-transcript' ? resolveTranscriptPath(workDir, sessionId)
      : strategy === 'codex-transcript' ? locateCodexTranscript(sessionId) : null;
    const at = now();
    const open = usageDb.findOpenTurn(db, terminalId);
    const seed = () => {
      const totals = strategy === 'codex-transcript' && file ? readCodexTail(file)?.totals : null;
      let size = 0;
      if (strategy === 'claude-transcript' && file) { try { size = fs.statSync(file).size; } catch { /* unavailable */ } }
      ptyDb.putState(db, { terminal_id: terminalId, transcript_path: file || '', byte_offset: size,
        last_total_input: totals?.input ?? 0, last_total_output: totals?.output ?? 0,
        last_total_cached: totals?.cached ?? 0, updated_at: at });
    };
    if (phase === 'baseline') { if (!open) seed(); return; }
    if (phase === 'start') {
      if (open) return; // duplicate prompt/busy, or answering an in-turn permission
      db.transaction(() => {
        seed();
        usageDb.openTurn(db, { id: randomUUID(), terminalId, projectId: terminal.session_id,
          provider: terminal.type, model: cfg.model ?? '', role: cfg.role ?? '', startedAt: at,
          transport: 'pty', sessionId, coverage: strategy ? 'missing' : 'unsupported' });
      })();
      return;
    }
    // No guessed turn from an idle display, duplicate completion, or missed start.
    if (!open || open.ended_at !== null) return;
    db.transaction(() => {
      const prior = ptyDb.getState(db, terminalId);
      const context = { terminalId, provider: terminal.type, sessionId, now: at };
      if (strategy && file && prior && (!prior.transcript_path || prior.transcript_path === file)) {
        if (strategy === 'claude-transcript') {
          const tail = readClaudeTail(file, prior.byte_offset);
          if (tail && tail.nextOffset >= prior.byte_offset) {
            if (tail.incomplete) db.prepare("UPDATE usage_turns SET coverage='partial' WHERE id=?").run(open.id);
            for (const measurement of tail.measurements) recordMeasurement(db, open.id, context, measurement);
            ptyDb.putState(db, { ...prior, transcript_path: file, byte_offset: tail.nextOffset, updated_at: at });
          } else { seed(); db.prepare("UPDATE usage_turns SET coverage='partial' WHERE id=?").run(open.id); }
        } else {
          const tail = readCodexTail(file);
          if (tail?.totals && (prior.transcript_path || !open.external_session_id)) {
            const input = tail.totals.input - prior.last_total_input;
            const cached = tail.totals.cached - prior.last_total_cached;
            const output = tail.totals.output - prior.last_total_output;
            if (input >= 0 && cached >= 0 && output >= 0 && (input || cached || output)) recordMeasurement(db, open.id, context, {
              input: Math.max(0, input-cached), output, cacheRead: cached, cacheCreate: 0,
              model: tail.model, source: 'pty', eventId: nativeTurnId || `turn:${open.id}`,
              coverage: 'partial', // transcript total has no per-response model breakdown
            });
            else if (input < 0 || cached < 0 || output < 0) db.prepare("UPDATE usage_turns SET coverage='partial' WHERE id=?").run(open.id);
          }
          seed();
        }
      } else if (strategy) { seed(); db.prepare("UPDATE usage_turns SET coverage='partial' WHERE id=?").run(open.id); }
      usageDb.closeTurn(db, open.id, at, threadStatus === 'error' ? 'error' : threadStatus === 'needs_input' ? 'needs_help' : 'idle');
      db.prepare('UPDATE usage_turns SET native_turn_id=? WHERE id=?').run(nativeTurnId ?? null, open.id);
    })();
    deps.onTurnClosed?.();
  };
}
