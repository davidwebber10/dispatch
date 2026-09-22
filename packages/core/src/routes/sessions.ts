import { Router } from 'express';
import type Database from 'better-sqlite3';
import type { SessionService } from '../sessions/service.js';
import type { EventBroadcaster } from '../ws/events.js';
import { listRecentSessions } from '../sessions/cc-sessions.js';
import { listRecentCodexSessions } from '../sessions/codex-sessions.js';
import { AGENT_CLI, isAgentType } from '../providers/agent-types.js';
import { PERSONA_TYPES, type PersonaType, readOverseerWorkers } from '../settings/overseer-workers.js';
import { resolveWorker } from '../overseer/worker-matrix.js';
import { harnessCapabilities } from '../providers/capabilities.js';
import { isProviderInstalled } from '../setup/detect.js';

export function createSessionsRouter(sessionService: SessionService, broadcaster: EventBroadcaster | undefined, db: Database.Database): Router {
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
      const warning = req.body.workingDir?.startsWith('/mnt/')
        ? 'This project lives on the Windows filesystem (/mnt/*): expect slow file I/O and case-insensitive names. Prefer a path inside the Linux filesystem (~/…).'
        : undefined;
      res.status(201).json({ ...session, ...(warning ? { warning } : {}) });
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

  // GET /api/sessions/:id/codex-recent — recent Codex sessions in this project's
  // folder, for the new-thread "resume" picker.
  router.get('/:id/codex-recent', async (req, res) => {
    const session = sessionService.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    try { res.json(await listRecentCodexSessions(session.workingDir)); }
    catch { res.json([]); }
  });

  // GET|POST /api/sessions/:id/overseer/coordinator — find-or-create this project's
  // Overseer coordinator thread (structured, config.role='coordinator'). Idempotent.
  const ensureCoordinator = (req: import('express').Request, res: import('express').Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const opts: { model?: string; workerHarness?: import('../providers/agent-types.js').AgentType } = {};
      if (typeof body.model === 'string' && body.model.trim()) opts.model = body.model.trim();
      if (body.workerHarness !== undefined) {
        if (typeof body.workerHarness !== 'string' || !isAgentType(body.workerHarness)) {
          return res.status(400).json({ error: 'workerHarness must be one of the agent harness types' });
        }
        opts.workerHarness = body.workerHarness;
      }
      const terminal = sessionService.ensureCoordinator(req.params.id, opts);
      broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: req.params.id });
      res.json({ terminalId: terminal.id });
    } catch (err: any) {
      res.status(err?.message === 'Session not found' ? 404 : 400).json({ error: err.message });
    }
  };
  router.post('/:id/overseer/coordinator', ensureCoordinator);
  router.get('/:id/overseer/coordinator', ensureCoordinator);

  // GET /api/sessions/:id/overseer/worker-defaults?agentType=&harness= — the resolved
  // harness/model a spawned worker of this type would get. `harness`, when present, is the
  // caller's own explicit pick (agency-mcp's spawn_agent/queue_agent `harness` arg) — it is
  // fed through resolveWorker's `explicit` precedence rather than bypassing resolution, so
  // the availability guard below still runs for it. agency-mcp calls this before creating a
  // worker thread.
  router.get('/:id/overseer/worker-defaults', async (req, res) => {
    const agentType = req.query.agentType;
    if (typeof agentType !== 'string' || !(PERSONA_TYPES as readonly string[]).includes(agentType)) {
      return res.status(400).json({ error: `agentType must be one of: ${PERSONA_TYPES.join(', ')}` });
    }
    const harnessParam = req.query.harness;
    let explicitHarness: import('../providers/agent-types.js').AgentType | undefined;
    if (harnessParam !== undefined) {
      if (typeof harnessParam !== 'string' || !isAgentType(harnessParam)) {
        return res.status(400).json({ error: 'harness must be one of the agent harness types' });
      }
      explicitHarness = harnessParam;
    }
    const coordinator = sessionService.findCoordinator(req.params.id);
    const sessionDefault = coordinator?.config?.workerHarness;
    const resolved = resolveWorker({
      agentType: agentType as PersonaType,
      explicit: explicitHarness ? { harness: explicitHarness } : undefined,
      matrix: readOverseerWorkers(db),
      sessionDefault: typeof sessionDefault === 'string' && isAgentType(sessionDefault) ? sessionDefault : undefined,
    });
    const cap = harnessCapabilities().find((h) => h.type === resolved.harness);
    const structurallyAvailable = !!cap && cap.modes.length > 0;
    if (!structurallyAvailable) {
      return res.json({ ...resolved, available: false, reason: `${resolved.harness} structured transport is disabled on this server` });
    }
    // Structured transport is enabled, but that doesn't mean the CLI is actually installed —
    // an uninstalled binary would still create a thread that dead-ends the moment it spawns.
    const installed = await isProviderInstalled(AGENT_CLI[resolved.harness]);
    const available = installed;
    res.json({ ...resolved, available, ...(available ? {} : { reason: `${resolved.harness} CLI is not installed on this server` }) });
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
