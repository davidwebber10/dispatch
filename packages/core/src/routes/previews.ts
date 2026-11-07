import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Router } from 'express';
import { keyRoute, policyRouter, needs } from '../auth/route-policy.js';
import { ownProjectRule } from '../auth/key-rules.js';
import { principalOf } from '../auth/request-principal.js';
import { insideRealRoot } from '../files/confine.js';
import { setFileHeaders, HTML_SANDBOX_CSP } from '../http/active-content.js';
import { PROJECT_FILE_MIME as PREVIEW_MIME, ProjectFileError as PreviewError, checkProjectFile as checkPreviewFile } from '../plugins/files.js';
import * as previewsDb from '../db/previews.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import type { EventBroadcaster } from '../ws/events.js';

/**
 * Previews (docs/superpowers/specs/2026-10-28-previews-design.md): a thread hands the user files
 * to look at and a string to copy; the user finds them in the Previews key, header button and
 * rail view. The routes keep the arbitrary-file-read door shut: a path must be inside the
 * project folder after symlinks are resolved, carry a known extension, and be a regular file.
 */

/** The checks and limits now live with the plugin file references (slice 4); these names stay until the routes go. */
export { PROJECT_FILE_MIME as PREVIEW_MIME, PROJECT_FILE_MAX_BYTES as PREVIEW_MAX_FILE_BYTES, ProjectFileError as PreviewError, checkProjectFile as checkPreviewFile } from '../plugins/files.js';
export { HTML_SANDBOX_CSP } from '../http/active-content.js';
export const PREVIEW_MAX_FILES = 20;
export const PREVIEW_MAX_TEXT = 64 * 1024;

export function createPreviewsRouter(db: Database.Database, broadcaster: EventBroadcaster): Router {
  const router = policyRouter();

  // A thread posts into its own project only (a preview is a write; reads reach every project since PK-5).
  router.post('/sessions/:id/previews', keyRoute({ thread: ownProjectRule, roleRun: ownProjectRule }), (req, res) => {
    const session = sessionsDb.getById(db, req.params.id);
    if (!session) return void res.status(404).json({ error: 'session not found' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const text = typeof body.text === 'string' && body.text.trim() ? body.text : null;
      if (text && text.length > PREVIEW_MAX_TEXT) throw new PreviewError('text too long (max 64 KB)');
      const paths = Array.isArray(body.paths) ? body.paths : [];
      if (paths.length > PREVIEW_MAX_FILES) throw new PreviewError(`too many files (max ${PREVIEW_MAX_FILES})`);
      const files = paths.map((p) => checkPreviewFile(session.working_dir, p));
      if (!text && files.length === 0) throw new PreviewError('a preview needs text or at least one path');
      // The posting thread, for the context line: the key names it; the owner may name one in the body.
      // (A unit test that mounts this router alone has no principal middleware: that caller is the owner.)
      let principal: ReturnType<typeof principalOf> | null = null;
      try { principal = principalOf(req); } catch { principal = null; }
      const terminalId = principal?.kind === 'thread' ? principal.terminalId
        : typeof body.terminalId === 'string' ? body.terminalId : null;
      const terminal = terminalId ? terminalsDb.getById(db, terminalId) : null;
      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200)
        : files.length ? files[0].name : 'Text';
      const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 1000) : null;
      const preview = previewsDb.create(db, {
        sessionId: session.id, sessionName: session.name,
        terminalId: terminal?.id ?? terminalId, terminalLabel: terminal?.label ?? null,
        title, note, text, files,
      });
      broadcaster.broadcast({ type: 'preview:new', preview });
      res.status(201).json(preview);
    } catch (err) {
      if (err instanceof PreviewError) return void res.status(err.status).json({ error: err.message });
      throw err;
    }
  });

  router.get('/previews', keyRoute({ plugin: needs('read:previews') }), (req, res) => {
    const limit = Number(req.query.limit) || 200;
    res.json({ previews: previewsDb.list(db, { limit }), unseen: previewsDb.unseenCount(db) });
  });

  router.get('/sessions/:id/previews', keyRoute({ plugin: needs('read:previews') }), (req, res) => {
    const limit = Number(req.query.limit) || 200;
    res.json({ previews: previewsDb.list(db, { sessionId: req.params.id, limit }), unseen: previewsDb.unseenCount(db, req.params.id) });
  });

  router.post('/previews/:id/seen', (req, res) => {
    const p = previewsDb.markSeen(db, req.params.id);
    if (!p) return void res.status(404).json({ error: 'preview not found' });
    broadcaster.broadcast({ type: 'preview:changed', id: p.id, sessionId: p.sessionId, seenAt: p.seenAt });
    res.json(p);
  });

  router.delete('/previews/:id', (req, res) => {
    const p = previewsDb.getById(db, req.params.id);
    if (!p) return void res.status(404).json({ error: 'preview not found' });
    previewsDb.remove(db, p.id);
    broadcaster.broadcast({ type: 'preview:changed', id: p.id, sessionId: p.sessionId, deleted: true });
    res.status(204).end();
  });

  // The bytes of file k. Re-checked against the project's CURRENT folder: a project moved since
  // the post, or a file replaced by a symlink, must not turn this into a read outside it.
  router.get('/previews/:id/files/:k', (req, res) => {
    const p = previewsDb.getById(db, req.params.id);
    const file = p?.files[Number(req.params.k)];
    if (!p || !file) return void res.status(404).json({ error: 'file not found' });
    const session = sessionsDb.getById(db, p.sessionId);
    if (!session || !insideRealRoot(session.working_dir, file.path) || !fs.existsSync(file.path)) {
      return void res.status(404).json({ error: 'file not found' });
    }
    const mime = PREVIEW_MIME[path.extname(file.path).toLowerCase()] ?? 'application/octet-stream';
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('Content-Disposition', `inline; filename="${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}"`);
    // HTML runs scripts in an opaque origin; SVG and other markup get the plain sandbox (no scripts at all).
    setFileHeaders(res, mime, mime === 'text/html' ? HTML_SANDBOX_CSP : 'sandbox');
    res.type(mime);
    res.sendFile(file.path);
  });

  return router;
}
