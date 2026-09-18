import { randomUUID } from 'crypto';
import type { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import * as usageDb from '../db/usage.js';
import * as terminalsDb from '../db/terminals.js';
import { recordMeasurement } from '../db/telemetry.js';
import { subscribeHarnessEvents } from '../runtime/adapter.js';
import type { HarnessEvent } from '../runtime/events.js';

export interface RecorderDeps {
  db: Database.Database;
  transport?: 'structured' | 'runner';
  now?: () => string;
  onTurnClosed?: () => void;
}

/** Synchronous reducer. The lifecycle owner commits this alongside thread state. */
export function recordHarnessUsage(db: Database.Database, event: HarnessEvent): boolean {
  const terminal = terminalsDb.getById(db, event.terminalId);
  if (!terminal) return false;
  const active = usageDb.findOpenTurn(db, event.terminalId);
  if (event.type === 'turn.started') {
    if (active) {
      if (event.nativeTurnId) db.prepare('UPDATE usage_turns SET native_turn_id=? WHERE id=?').run(event.nativeTurnId, active.id);
      return false;
    }
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(terminal.config || '{}'); } catch { /* defaults */ }
    const id = event.turnId ?? randomUUID();
    usageDb.openTurn(db, { id, terminalId: terminal.id, projectId: terminal.session_id, provider: terminal.type,
      model: typeof cfg.model === 'string' ? cfg.model : '', role: cfg.role ?? '', startedAt: event.observedAt,
      transport: event.transport, sessionId: event.sessionId ?? terminal.external_id ?? '' });
    if (event.nativeTurnId) db.prepare('UPDATE usage_turns SET native_turn_id=? WHERE id=?').run(event.nativeTurnId, id);
  } else if (event.type === 'usage.observed') {
    if (active?.native_turn_id && event.nativeTurnId && active.native_turn_id !== event.nativeTurnId) return false;
    // One final event can contain several model/cost counters. All commit together.
    db.transaction(() => {
      for (const observation of event.measurements) {
        const measurement = { ...observation, model: observation.model || active?.model || '' };
        recordMeasurement(db, active?.id ?? null, { terminalId: terminal.id, provider: terminal.type,
          sessionId: event.sessionId ?? terminal.external_id ?? '', now: event.observedAt }, measurement);
        if (active && measurement.model) usageDb.setModel(db, active.id, measurement.model);
      }
    })();
  } else if (active && ['turn.completed', 'turn.failed', 'process.exited'].includes(event.type)) {
    const outcome = event.type === 'turn.completed' ? event.outcome : event.type === 'turn.failed' || event.type === 'process.exited' && event.exitCode !== 0 ? 'error' : 'exit';
    usageDb.closeTurn(db, active.id, event.observedAt, outcome);
    return true;
  }
  return false;
}

/** Compatibility collector for isolated consumers; the server uses the lifecycle owner. */
export function attachUsageRecorder(manager: EventEmitter, deps: RecorderDeps): () => void {
  return subscribeHarnessEvents(manager, id => deps.db.open ? terminalsDb.getById(deps.db, id)?.type : undefined, event => {
    try { if (recordHarnessUsage(deps.db, event)) deps.onTurnClosed?.(); }
    catch (err) { console.warn('Usage capture failed:', err instanceof Error ? err.message : String(err)); }
  }, deps.transport, deps.now);
}

/** A daemon crash leaves the end time unknown; never invent a long duration. */
export function closeInterruptedTurns(db: Database.Database): number {
  return db.prepare(`UPDATE usage_turns SET ended_at=started_at, outcome='interrupted', duration_ms=NULL,
    coverage=CASE WHEN telemetry_version=1 AND coverage!='unsupported' THEN 'partial' ELSE coverage END
    WHERE ended_at IS NULL`).run().changes;
}
