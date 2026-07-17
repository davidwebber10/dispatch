import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import type { StatusService } from '../status/service.js';
import type { PushService } from './service.js';

/**
 * Wires the "thread settled" edge (working → needs_input/waiting) to web push.
 * Per-thread opt-in: only threads with config.alertsEnabled (the bell UI) alert.
 * Copy is template-only — thread label + what happened, never model content.
 */
export function wireThreadSettledPush(
  db: Database.Database,
  statusService: StatusService,
  pushService: Pick<PushService, 'notifyThread'>,
): void {
  statusService.setThreadSettledHook(({ terminalId, sessionId, threadStatus }) => {
    const row = terminalsDb.getById(db, terminalId);
    if (!row) return;
    let config: Record<string, any> = {};
    try { config = JSON.parse(row.config || '{}'); } catch { /* malformed → alerts off */ }
    if (config.alertsEnabled !== true) return;
    const body = threadStatus === 'needs_input' ? 'Is asking a question' : 'Completed its task';
    void pushService.notifyThread({ terminalId, sessionId, title: row.label || 'Thread', body });
  });
}
