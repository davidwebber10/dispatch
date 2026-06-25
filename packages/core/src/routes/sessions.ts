import { Router } from 'express';
import type { SessionService } from '../sessions/service.js';
import type { EventBroadcaster } from '../ws/events.js';
import { listRecentSessions } from '../sessions/cc-sessions.js';

export function createSessionsRouter(sessionService: SessionService, broadcaster?: EventBroadcaster): Router {
  const router = Router();

  // POST /api/sessions/reorder — reorder sessions (before parameterized routes)
  router.post('/reorder', (req, res) => {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
    sessionService.reorderSessions(order);
    res.json({ ok: true });
  });

  // POST /api/sessions — create a new session
  router.post('/', (req, res) => {
    try {
      const session = sessionService.create(req.body);
      broadcaster?.broadcast({ type: 'session:created', session });
      res.status(201).json(session);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/sessions — list sessions
  router.get('/', (req, res) => {
    const status = req.query.status as string | undefined;
    const sessions = sessionService.list(status);
    res.json(sessions);
  });

  // GET /api/sessions/:id — get a session
  router.get('/:id', (req, res) => {
    const session = sessionService.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  });

  // GET /api/sessions/:id/cc-recent — recent Claude Code sessions in this project's
  // folder, for the new-thread "resume" picker.
  router.get('/:id/cc-recent', async (req, res) => {
    const session = sessionService.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    try { res.json(await listRecentSessions(session.workingDir)); }
    catch { res.json([]); }
  });

  // PATCH /api/sessions/:id — update session fields
  router.patch('/:id', (req, res) => {
    const session = sessionService.update(req.params.id, req.body);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    broadcaster?.broadcast({ type: 'session:updated', sessionId: session.id });
    res.json(session);
  });

  // POST /api/sessions/:id/relaunch — re-spawn PTY for an existing session
  router.post('/:id/relaunch', (req, res) => {
    const session = sessionService.relaunch(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  });

  // POST /api/sessions/:id/stop — stop a session
  router.post('/:id/stop', (req, res) => {
    sessionService.stop(req.params.id);
    res.status(204).end();
  });

  // DELETE /api/sessions/:id — archive a session
  router.delete('/:id', (req, res) => {
    sessionService.archive(req.params.id);
    broadcaster?.broadcast({ type: 'session:archived', sessionId: req.params.id });
    res.status(204).end();
  });

  return router;
}
