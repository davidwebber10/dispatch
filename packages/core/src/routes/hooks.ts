import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { mapHookEventToStatus } from '../sessions/status.js';
import type { EventBroadcaster } from '../ws/events.js';

export function createHooksRouter(db: Database.Database, broadcaster: EventBroadcaster): Router {
  const router = Router();

  router.post('/terminal/:terminalId', (req, res) => {
    const { terminalId } = req.params;
    const { hook_event_name, session_id: claudeSessionId } = req.body;

    const terminal = terminalsDb.getById(db, terminalId);
    if (!terminal) return res.json({ ok: true });

    if (terminal.external_id) {
      if (claudeSessionId && terminal.external_id !== claudeSessionId) {
        return res.json({ ok: true });
      }
    } else if (claudeSessionId) {
      const sessions = sessionsDb.list(db);
      for (const session of sessions) {
        const terminals = terminalsDb.listBySession(db, session.id);
        for (const other of terminals) {
          if (other.id !== terminalId && other.external_id === claudeSessionId) {
            return res.json({ ok: true });
          }
        }
      }
    }

    const sessionId = terminal.session_id;

    if (claudeSessionId && !terminal.external_id) {
      terminalsDb.updateExternalId(db, terminalId, claudeSessionId);
      const session = sessionsDb.getById(db, sessionId);
      if (session && !session.external_id) {
        sessionsDb.updateExternalId(db, sessionId, claudeSessionId);
      }
    }

    const status = mapHookEventToStatus(hook_event_name);

    // Hooks own only the needs_input signal; working/waiting is driven by live
    // PTY activity (see startPtyTimingLoop). A working/waiting hook just clears a
    // stale needs_input so the thread isn't stuck showing "needs input".
    if (status === 'needs_input') {
      terminalsDb.updateStatus(db, terminalId, status);
      broadcaster.broadcast({ type: 'terminal:status', terminalId, status });
    } else if (status === 'working' || status === 'waiting') {
      const current = terminalsDb.getById(db, terminalId);
      if (current?.status === 'needs_input') {
        terminalsDb.updateStatus(db, terminalId, 'waiting');
        broadcaster.broadcast({ type: 'terminal:status', terminalId, status: 'waiting' });
      }
    }

    if (status) {
      const allTerminals = terminalsDb.listBySession(db, sessionId);
      let sessionStatus = 'waiting';
      for (const item of allTerminals) {
        const itemStatus = item.status || 'waiting';
        if (itemStatus === 'working') {
          sessionStatus = 'working';
          break;
        }
        if (itemStatus === 'needs_input') {
          sessionStatus = 'needs_input';
        }
      }
      sessionsDb.updateStatus(db, sessionId, sessionStatus);
      sessionsDb.touchActivity(db, sessionId);
      broadcaster.broadcast({ type: 'session:status', sessionId, status: sessionStatus });
    }

    res.json({ ok: true });
  });

  router.post('/event', (_req, res) => {
    res.json({ ok: true });
  });

  return router;
}
