import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import { rowToSession } from '../types.js';

export function createFilesRouter(db: Database.Database): Router {
  const router = Router({ mergeParams: true });
  const upload = multer({ dest: '/tmp/commandcenter-uploads' });
  const inboxUpload = multer({
    dest: '/tmp/commandcenter-uploads',
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  /** Resolve and sandbox a path within the session's working directory */
  function resolveSafe(workingDir: string, requestedPath: string): string | null {
    const root = path.resolve(workingDir);
    const resolved = path.resolve(root, requestedPath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return resolved;
  }

  /**
   * Read-only resolver. A tool call may reference a file OUTSIDE the session's
   * working dir — e.g. an agent whose cwd is one repo but which edits another
   * (the "View file" button in View opens exactly these). The agent already has
   * full filesystem access, so for READS we honor an absolute path as-is;
   * relative paths stay sandboxed to the working dir. Writes/listing/upload keep
   * using resolveSafe.
   */
  function resolveRead(workingDir: string, requestedPath: string): string | null {
    if (path.isAbsolute(requestedPath)) return path.resolve(requestedPath);
    return resolveSafe(workingDir, requestedPath);
  }

  function sanitizeFilename(filename: string): string {
    const sanitized = path.basename(filename)
      .replace(/[\x00-\x1F\x7F]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return sanitized || 'upload';
  }

  /** Middleware: load session and attach to req */
  router.use((req, res, next) => {
    const sessionId = req.params.id;
    const row = sessionsDb.getById(db, sessionId);
    if (!row) return res.status(404).json({ error: 'Session not found' });
    (req as any).session = rowToSession(row);
    next();
  });

  // GET /api/sessions/:id/files?path=. — list directory
  router.get('/', (req, res) => {
    const session = (req as any).session;
    const requestedPath = (req.query.path as string) || '.';
    const resolved = resolveSafe(session.workingDir, requestedPath);
    if (!resolved) return res.status(403).json({ error: 'Path traversal not allowed' });

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const result = entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        path: path.relative(session.workingDir, path.join(resolved, entry.name)),
      }));
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/sessions/:id/files/read?path=file.txt — read file
  router.get('/read', (req, res) => {
    const session = (req as any).session;
    const requestedPath = req.query.path as string;
    if (!requestedPath) return res.status(400).json({ error: 'Missing path parameter' });

    const resolved = resolveRead(session.workingDir, requestedPath);
    if (!resolved) return res.status(403).json({ error: 'Path traversal not allowed' });

    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      res.json({ content, path: requestedPath });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // PUT /api/sessions/:id/files/write?path=file.txt — write file
  router.put('/write', (req, res) => {
    const session = (req as any).session;
    const requestedPath = req.query.path as string;
    if (!requestedPath) return res.status(400).json({ error: 'Missing path parameter' });

    const resolved = resolveSafe(session.workingDir, requestedPath);
    if (!resolved) return res.status(403).json({ error: 'Path traversal not allowed' });

    try {
      fs.writeFileSync(resolved, req.body.content);
      res.json({ ok: true, path: requestedPath });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/sessions/:id/files/upload — upload file
  router.post('/upload', upload.single('file'), (req, res) => {
    const session = (req as any).session;
    const requestedPath = (req.query.path as string) || '.';
    const resolved = resolveSafe(session.workingDir, requestedPath);
    if (!resolved) return res.status(403).json({ error: 'Path traversal not allowed' });

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
      const dest = path.join(resolved, req.file.originalname);
      if (!dest.startsWith(session.workingDir)) return res.status(403).json({ error: 'Path traversal not allowed' });
      fs.copyFileSync(req.file.path, dest);
      fs.unlinkSync(req.file.path);
      res.json({ ok: true, path: path.relative(session.workingDir, dest) });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/sessions/:id/files/inbox — upload file into .dispatch/inbox
  router.post('/inbox', (req, res) => {
    inboxUpload.single('file')(req, res, (err: any) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File is larger than 50 MB' });
      }
      if (err) return res.status(400).json({ error: err.message });

      const session = (req as any).session;
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      try {
        const inboxDir = path.join(session.workingDir, '.dispatch', 'inbox');
        fs.mkdirSync(inboxDir, { recursive: true });

        const safeFilename = sanitizeFilename(req.file.originalname);
        const suffix = Math.random().toString(36).slice(2, 10) || 'upload';
        const filename = `${Date.now()}-${suffix}-${safeFilename}`;
        const absolutePath = path.join(inboxDir, filename);
        const relativePath = path.relative(session.workingDir, absolutePath);

        fs.copyFileSync(req.file.path, absolutePath);
        fs.unlinkSync(req.file.path);
        res.json({ ok: true, path: relativePath, absolutePath });
      } catch (copyErr: any) {
        try {
          if (req.file?.path) fs.unlinkSync(req.file.path);
        } catch {}
        res.status(400).json({ error: copyErr.message });
      }
    });
  });

  // POST /api/sessions/:id/files/mkdir?path=dir — create directory
  router.post('/mkdir', (req, res) => {
    const session = (req as any).session;
    const requestedPath = req.query.path as string;
    if (!requestedPath) return res.status(400).json({ error: 'Missing path parameter' });

    const resolved = resolveSafe(session.workingDir, requestedPath);
    if (!resolved) return res.status(403).json({ error: 'Path traversal not allowed' });

    try {
      fs.mkdirSync(resolved, { recursive: true });
      res.json({ ok: true, path: requestedPath });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/sessions/:id/files/rename — rename a file or directory
  router.post('/rename', (req, res) => {
    const session = (req as any).session;
    const fromPath = req.body.from as string;
    const toPath = req.body.to as string;
    if (!fromPath || !toPath) return res.status(400).json({ error: 'Missing from or to path' });

    const from = resolveSafe(session.workingDir, fromPath);
    const to = resolveSafe(session.workingDir, toPath);
    if (!from || !to) return res.status(403).json({ error: 'Path traversal not allowed' });

    try {
      fs.renameSync(from, to);
      res.json({ ok: true, path: path.relative(session.workingDir, to) });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // DELETE /api/sessions/:id/files?path=file.txt — delete file or directory
  router.delete('/', (req, res) => {
    const session = (req as any).session;
    const requestedPath = req.query.path as string;
    if (!requestedPath) return res.status(400).json({ error: 'Missing path parameter' });

    const resolved = resolveSafe(session.workingDir, requestedPath);
    if (!resolved) return res.status(403).json({ error: 'Path traversal not allowed' });

    try {
      fs.rmSync(resolved, { recursive: true });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
