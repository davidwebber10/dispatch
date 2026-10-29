import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Router } from 'express';
import { keyRoute, policyRouter } from '../auth/route-policy.js';
import { readSessionRule } from '../auth/key-rules.js';
import { principalOf } from '../auth/request-principal.js';
import { insideRealRoot } from '../files/confine.js';
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

/** Extension → content type of the files a preview may carry. */
export const PREVIEW_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.html': 'text/html', '.htm': 'text/html',
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
};
export const PREVIEW_MAX_FILES = 20;
export const PREVIEW_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const PREVIEW_MAX_TEXT = 64 * 1024;
/** An HTML preview runs with an opaque origin: no cookie, no app API, no framing of the app. */
export const HTML_SANDBOX_CSP = 'sandbox allow-scripts allow-popups allow-forms allow-modals';

function resolveSafe(root: string, requested: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requested);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

export class PreviewError extends Error {
  constructor(message: string, readonly status: number = 400) { super(message); }
}

/** Check and describe one requested file. Throws PreviewError with the reason the thread should read. */
export function checkPreviewFile(workingDir: string, requested: unknown): previewsDb.PreviewFile {
  if (typeof requested !== 'string' || !requested.trim()) throw new PreviewError('each path must be a non-empty string');
  const abs = resolveSafe(workingDir, requested.trim());
  if (!abs || !insideRealRoot(workingDir, abs)) throw new PreviewError(`path is outside the project folder: ${requested}`);
  const mime = PREVIEW_MIME[path.extname(abs).toLowerCase()];
  if (!mime) throw new PreviewError(`unsupported file type: ${path.basename(abs)} (png, jpg, gif, webp, svg, pdf, html, md, txt, csv, json)`);
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { throw new PreviewError(`file not found: ${requested}`, 404); }
  if (!st.isFile()) throw new PreviewError(`not a file: ${requested}`);
  if (st.size > PREVIEW_MAX_FILE_BYTES) throw new PreviewError(`file too large (max 50 MB): ${requested}`);
  return { path: abs, name: path.basename(abs), mime, size: st.size };
}

export function createPreviewsRouter(db: Database.Database, broadcaster: EventBroadcaster): Router {
  const router = policyRouter();

  // A thread may post where it may read: its own project, any project for an overseer.
  router.post('/sessions/:id/previews', keyRoute({ thread: readSessionRule, roleRun: readSessionRule }), (req, res) => {
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

  router.get('/previews', (req, res) => {
    const limit = Number(req.query.limit) || 200;
    res.json({ previews: previewsDb.list(db, { limit }), unseen: previewsDb.unseenCount(db) });
  });

  router.get('/sessions/:id/previews', (req, res) => {
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
    if (mime === 'text/html') res.setHeader('Content-Security-Policy', HTML_SANDBOX_CSP);
    res.type(mime);
    res.sendFile(file.path);
  });

  return router;
}
