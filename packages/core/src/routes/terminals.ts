import { Router } from 'express';
import type { SessionService } from '../sessions/service.js';
import { isPtyType } from '../db/terminals.js';
import type { EventBroadcaster } from '../ws/events.js';
import type { StatusService } from '../status/service.js';

const VALID_TYPES = ['claude-code', 'codex', 'shell', 'browser', 'notes', 'file'];

export function createTerminalsRouter(sessionService: SessionService, broadcaster?: EventBroadcaster, statusService?: StatusService): Router {
  const router = Router();

  // GET /api/sessions/:id/terminals/archived — MUST be before the generic list route
  router.get('/sessions/:id/terminals/archived', (req, res) => {
    try {
      const terminals = sessionService.listArchivedTerminals(req.params.id);
      res.json(terminals);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/sessions/:id/terminals — create a new tab. When `queued:true` (with
  // `task`), the structured thread is persisted as status='queued' WITHOUT spawning
  // its process — POST /api/terminals/:id/start promotes it later.
  router.post('/sessions/:id/terminals', (req, res) => {
    try {
      const { type, label, skipPermissions, workingDir, externalId, config, queued, task } = req.body;
      if (!type || !VALID_TYPES.includes(type)) {
        return res.status(400).json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` });
      }

      if (isPtyType(type)) {
        if (queued) {
          const terminal = sessionService.createQueuedTerminal(req.params.id, type, label, config, typeof task === 'string' ? task : '');
          broadcaster?.broadcast({ type: 'terminal:created', terminal });
          broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: req.params.id });
          return res.status(201).json(terminal);
        }
        const terminal = sessionService.createTerminal(req.params.id, type, label, skipPermissions, workingDir, externalId, config);
        broadcaster?.broadcast({ type: 'terminal:created', terminal });
        broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: req.params.id });
        res.status(201).json(terminal);
      } else {
        const tab = sessionService.createTab(req.params.id, type, label || type, config);
        broadcaster?.broadcast({ type: 'terminal:created', terminal: tab });
        broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: req.params.id });
        res.status(201).json(tab);
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/sessions/:id/terminals — list all active tabs for a session
  router.get('/sessions/:id/terminals', (req, res) => {
    try {
      const terminals = sessionService.listTerminals(req.params.id);
      res.json(terminals);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/terminals/:terminalId — get a single terminal
  router.get('/terminals/:terminalId', (req, res) => {
    const terminal = sessionService.getTerminal(req.params.terminalId);
    if (!terminal) return res.status(404).json({ error: 'Terminal not found' });
    res.json(terminal);
  });

  // GET /api/terminals/:terminalId/conversation?since=N&before=M&beforeUuid=U&limit=L —
  // windowed transcript (View). Default: most recent `limit` lines; `since`: new lines
  // after N (poll); `before`: the `limit` lines before M (older history for infinite
  // scroll); `beforeUuid`: same, but anchored on a transcript-line uuid instead of a line
  // index (see getConversation's doc comment — lets a ws-replayed page anchor precisely).
  router.get('/terminals/:terminalId/conversation', (req, res) => {
    const num = (v: unknown) => (v != null ? Number(v) : undefined);
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    res.json(sessionService.getConversation(req.params.terminalId, {
      since: num(req.query.since),
      before: num(req.query.before),
      beforeUuid: str(req.query.beforeUuid),
      limit: num(req.query.limit),
    }));
  });

  // GET /api/terminals/:terminalId/conversation/search?q=... — full-history search.
  router.get('/terminals/:terminalId/conversation/search', (req, res) => {
    res.json(sessionService.searchConversation(req.params.terminalId, String(req.query.q ?? '')));
  });

  // POST /api/terminals/:terminalId/message { text } | { content } — send a structured
  // message to a stream-json session. Back-compat: a plain `text` string still works;
  // `content` additionally accepts a string OR an array of content blocks (e.g. a real
  // base64 image block, so an attached image reaches the model as a picture it can SEE).
  // Optional `source: 'user' | 'coordinator'` tags WHO sent the turn (for the UI-facing echo
  // only — never forwarded to the CLI); a bare 'user' send to a typed agent also notifies its
  // coordinator, since that's the one path where a human message could silently override
  // what the coordinator thinks it told the agent to do.
  router.post('/terminals/:terminalId/message', (req, res) => {
    const { text, content, source } = req.body ?? {};
    const payload = content !== undefined ? content : text;
    const ok = typeof payload === 'string' ? payload.length > 0 : Array.isArray(payload) && payload.length > 0;
    if (!ok) return res.status(400).json({ error: 'text (string) or content (string | block[]) is required' });
    try {
      sessionService.sendStructuredMessage(req.params.terminalId, payload, source);
      if (source === 'user') sessionService.noteUserMessageToAgent(req.params.terminalId, payload); // tell the coordinator
      res.status(204).end();
    } catch (e: any) { res.status(400).json({ error: e?.message ?? String(e) }); }
  });

  // GET /api/terminals/:terminalId/permission — the gated tool/question this thread
  // is blocked on (the membrane), or null when nothing is pending.
  router.get('/terminals/:terminalId/permission', (req, res) => {
    res.json(sessionService.getPendingPermission(req.params.terminalId));
  });

  // POST /api/terminals/:terminalId/permission { requestId?, decision:'allow'|'deny', answers?, message? }
  // — resolve the pending gated tool. allow folds an AskUserQuestion `answers` map into
  // the tool input; deny sends a message. On success the thread returns to working.
  router.post('/terminals/:terminalId/permission', (req, res) => {
    const { requestId, decision, answers, message } = req.body ?? {};
    if (decision !== 'allow' && decision !== 'deny') {
      return res.status(400).json({ error: "decision must be 'allow' or 'deny'" });
    }
    try {
      const ok = sessionService.answerPermission(req.params.terminalId, requestId, { decision, answers, message });
      if (!ok) return res.status(404).json({ error: 'no pending permission' });
      statusService?.markWorking(req.params.terminalId, 'Working…');
      res.status(204).end();
    } catch (e: any) { res.status(400).json({ error: e?.message ?? String(e) }); }
  });

  // POST /api/terminals/:terminalId/autonomy { mode:'supervised'|'autonomous' }
  // — set the per-agent autonomy dial. Supervised surfaces gated tools as Needs
  // (the membrane); autonomous auto-allows (runs free), resolving any currently
  // pending request. Persisted in config.autonomy so it survives a resume.
  router.post('/terminals/:terminalId/autonomy', (req, res) => {
    const { mode } = req.body ?? {};
    if (mode !== 'supervised' && mode !== 'autonomous') {
      return res.status(400).json({ error: "mode must be 'supervised' or 'autonomous'" });
    }
    try {
      const ok = sessionService.setAutonomy(req.params.terminalId, mode);
      if (!ok) return res.status(404).json({ error: 'Terminal not found' });
      const terminal = sessionService.getTerminal(req.params.terminalId);
      if (terminal) broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: terminal.sessionId });
      res.json(terminal ?? { ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message ?? String(e) }); }
  });

  // POST /api/terminals/:terminalId/interrupt — gracefully stop the current turn
  // WITHOUT killing the thread (sends the structured `interrupt` control on stdin).
  router.post('/terminals/:terminalId/interrupt', (req, res) => {
    try {
      const ok = sessionService.interrupt(req.params.terminalId);
      if (!ok) return res.status(409).json({ error: 'No live structured session to interrupt' });
      sessionService.noteAgentLifecycle(req.params.terminalId, 'interrupted'); // tell the coordinator
      res.status(204).end();
    } catch (e: any) { res.status(400).json({ error: e?.message ?? String(e) }); }
  });

  // POST /api/terminals/:terminalId/compact — trigger native Claude Code compaction on
  // the thread's current context (writes `/compact` on stdin; no chat bubble is added).
  router.post('/terminals/:terminalId/compact', (req, res) => {
    try {
      const ok = sessionService.compact(req.params.terminalId);
      if (!ok) return res.status(409).json({ error: 'No live structured session to compact' });
      res.status(204).end();
    } catch (e: any) { res.status(400).json({ error: e?.message ?? String(e) }); }
  });

  // POST /api/terminals/:terminalId/input { data } — write raw bytes to the live PTY.
  router.post('/terminals/:terminalId/input', (req, res) => {
    const data = req.body?.data;
    if (typeof data !== 'string') return res.status(400).json({ error: 'data (string) is required' });
    try {
      sessionService.writeToTerminal(req.params.terminalId, data);
      // A CR write means the thread is now working — surface it immediately,
      // before any hook fires (Codex relies on this; notify only reports completion).
      if (data.includes('\r') && data !== '\x1b') statusService?.markWorking(req.params.terminalId, 'Thinking…');
      res.status(204).end();
    } catch (e: any) { res.status(400).json({ error: e?.message ?? String(e) }); }
  });

  // POST /api/terminals/:terminalId/start — promote a queued terminal to a live
  // one: strip the queued markers, spawn the process, deliver the parked task.
  router.post('/terminals/:terminalId/start', (req, res) => {
    try {
      const terminal = sessionService.startQueuedTerminal(req.params.terminalId);
      if (!terminal) return res.status(404).json({ error: 'Terminal not found' });
      broadcaster?.broadcast({ type: 'terminal:created', terminal });
      broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: terminal.sessionId });
      res.json(terminal);
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? String(e) });
    }
  });

  // POST /api/terminals/:terminalId/relaunch
  router.post('/terminals/:terminalId/relaunch', async (req, res) => {
    const terminal = await sessionService.restartTerminal(req.params.terminalId);
    if (!terminal) return res.status(404).json({ error: 'Terminal not found' });
    broadcaster?.broadcast({ type: 'terminal:status', terminalId: terminal.id, status: 'working' });
    res.json(terminal);
  });

  // POST /api/terminals/:terminalId/branch — fork a Claude Code thread's conversation
  router.post('/terminals/:terminalId/branch', (req, res) => {
    try {
      const terminal = sessionService.branchTerminal(req.params.terminalId);
      broadcaster?.broadcast({ type: 'terminal:created', terminal });
      broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: terminal.sessionId });
      res.json(terminal);
    } catch (e: any) {
      res.status(e?.status === 422 ? 422 : 400).json({ error: e?.message || 'Branch failed' });
    }
  });

  // POST /api/terminals/:terminalId/restore
  router.post('/terminals/:terminalId/restore', (req, res) => {
    const terminal = sessionService.restoreTerminal(req.params.terminalId);
    if (!terminal) return res.status(404).json({ error: 'Terminal not found' });
    broadcaster?.broadcast({ type: 'terminal:created', terminal });
    broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: terminal.sessionId });
    res.json(terminal);
  });

  // POST /api/terminals/stop-all — stop all running PTYs
  router.post('/terminals/stop-all', (req, res) => {
    sessionService.stopAllTerminals();
    res.status(204).end();
  });

  // POST /api/terminals/:terminalId/stop
  router.post('/terminals/:terminalId/stop', (req, res) => {
    sessionService.stopTerminal(req.params.terminalId);
    sessionService.noteAgentLifecycle(req.params.terminalId, 'stopped'); // tell the coordinator
    res.status(204).end();
  });

  // POST /api/terminals/:terminalId/send-file-reference
  router.post('/terminals/:terminalId/send-file-reference', (req, res) => {
    const { path: requestedPath, mode } = req.body;
    if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
      return res.status(400).json({ error: 'path is required' });
    }

    try {
      const result = sessionService.sendFileReference(
        req.params.terminalId,
        requestedPath,
        mode === 'shell-path' ? 'shell-path' : 'agent-context',
      );
      if (!result) return res.status(404).json({ error: 'Terminal not found' });
      res.json({ ok: true, sentText: result.sentText });
    } catch (err: any) {
      if (err.message === 'Path traversal not allowed') {
        return res.status(403).json({ error: err.message });
      }
      if (err.message === 'Terminal process is not running') {
        return res.status(409).json({ error: err.message });
      }
      res.status(400).json({ error: err.message });
    }
  });

  // PATCH /api/terminals/:terminalId
  router.patch('/terminals/:terminalId', (req, res) => {
    const { label, config } = req.body;
    const terminal = sessionService.updateTab(req.params.terminalId, { label, config });
    if (!terminal) return res.status(404).json({ error: 'Terminal not found' });
    broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: terminal.sessionId });
    res.json(terminal);
  });

  // PATCH /api/terminals/:terminalId/auto-archive — merge the auto-archive policy
  // server-side. Deliberately NOT the generic PATCH above: that one replaces the
  // whole config blob (unpin depends on it), which would wipe transport/role/etc.
  router.patch('/terminals/:terminalId/auto-archive', (req, res) => {
    const { enabled, ms } = req.body;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    if (ms !== undefined && (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0)) {
      return res.status(400).json({ error: 'ms must be a positive number' });
    }
    const terminal = sessionService.setAutoArchive(req.params.terminalId, enabled, ms);
    if (!terminal) return res.status(404).json({ error: 'Terminal not found' });
    broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: terminal.sessionId });
    res.json(terminal);
  });

  // POST /api/sessions/:id/terminals/reorder — set tab order for a session
  router.post('/sessions/:id/terminals/reorder', (req, res) => {
    try {
      const { order } = req.body;
      if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of tab IDs' });
      sessionService.reorderTabs(req.params.id, order);
      broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: req.params.id });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/terminals/:terminalId/move — move tab to another project
  router.post('/terminals/:terminalId/move', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    const previous = sessionService.getTerminal(req.params.terminalId);
    const terminal = sessionService.moveTab(req.params.terminalId, sessionId);
    if (!terminal) return res.status(404).json({ error: 'Terminal not found' });
    if (previous && previous.sessionId !== terminal.sessionId) {
      broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: previous.sessionId });
    }
    broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: terminal.sessionId });
    res.json(terminal);
  });

  // DELETE /api/terminals/:terminalId
  router.delete('/terminals/:terminalId', (req, res) => {
    const terminal = sessionService.getTerminal(req.params.terminalId);
    sessionService.removeTerminal(req.params.terminalId);
    if (terminal) {
      broadcaster?.broadcast({
        type: 'terminal:removed',
        terminalId: terminal.id,
        sessionId: terminal.sessionId,
      });
      broadcaster?.broadcast({ type: 'session:tabs-changed', sessionId: terminal.sessionId });
    }
    res.status(204).end();
  });

  return router;
}
