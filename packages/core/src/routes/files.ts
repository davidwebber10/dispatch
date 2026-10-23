import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { Router } from 'express';
import multer from 'multer';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import { rowToSession } from '../types.js';
import { revealClientFrom } from '../files/reveal.js';
import { platform } from '../platform/index.js';

/** Upper bound on a single reveal: no native file manager can usefully select more, and this is
 *  the only route that shells out — an unbounded argv is not worth the risk. */
const MAX_REVEAL_PATHS = 256;

/** Cap on a file the editor reads: it is shown as text in the browser, so a larger one is not useful. */
const MAX_READ_BYTES = 5 * 1024 * 1024;
/** Cap on one upload into the project. The inbox keeps its own 50 MB cap. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Per-user temp folder for multer. A fixed shared name let another account create it first. DISPATCH_UPLOAD_DIR is for tests. */
export const UPLOAD_TMP_DIR = process.env.DISPATCH_UPLOAD_DIR
  || path.join(os.tmpdir(), `dispatch-uploads-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`);

/** Create (or re-check) the temp folder: owner-only, a real directory, owned by us. */
function ensureUploadDir(): void {
  fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(UPLOAD_TMP_DIR);
  if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
    throw new Error('upload temp folder is not owned by this user');
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(UPLOAD_TMP_DIR, 0o700);
}

/** A query value is only usable as a path when it is a single string (not `a[]=x` or `a[b]=x`). */
function queryPath(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function unlinkQuiet(file?: string): void {
  if (!file) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

const FLAT_CAP = 20000;
// Dependency and build-output dirs: huge, never what a search is for. Now that plain
// (not only hidden) ignored paths merge into the index, the ignored virtualenvs and
// build trees would otherwise fill the cap ahead of the files people want.
const FLAT_SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', 'venv', '.venv', 'target', 'coverage']);

function hasSkippedSegment(p: string): boolean {
  return p.split(/[\\/]/).some((seg) => FLAT_SKIP.has(seg));
}

/** True when some parent of `relPath` is a nested git checkout / worktree (has its own `.git`). */
function underNestedGit(workingDir: string, relPath: string, cache: Map<string, boolean>): boolean {
  const parts = relPath.split(/[\\/]/);
  let acc = workingDir;
  for (const part of parts.slice(0, -1)) {
    acc = path.join(acc, part);
    if (part === '.git') return true;
    let hit = cache.get(acc);
    if (hit === undefined) {
      hit = fs.existsSync(path.join(acc, '.git'));
      cache.set(acc, hit);
    }
    if (hit) return true;
  }
  return false;
}

function gitLsFiles(workingDir: string, extraArgs: string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', workingDir, 'ls-files', ...extraArgs, '-z'],
      { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout.split('\0').filter(Boolean)),
    );
  });
}

export function createFilesRouter(db: Database.Database): Router {
  const router = Router({ mergeParams: true });
  // Recreate the temp dir on EVERY request, not once at startup (multer's `dest`
  // shorthand): macOS purges /tmp entries idle for ~3 days, so on a long-running
  // daemon the dir vanishes mid-uptime and every upload then fails with ENOENT
  // until a restart.
  const tmpStorage = multer.diskStorage({
    // The name is chosen here and kept on the request, so a write that fails half way can still be removed.
    filename: (req, _file, cb) => {
      const name = `up-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      (req as any).uploadTmpPath = path.join(UPLOAD_TMP_DIR, name);
      cb(null, name);
    },
    destination: (_req, _file, cb) => {
      try {
        ensureUploadDir();
        cb(null, UPLOAD_TMP_DIR);
      } catch (err) {
        cb(err as Error, UPLOAD_TMP_DIR);
      }
    },
  });
  const upload = multer({ storage: tmpStorage, limits: { fileSize: MAX_UPLOAD_BYTES } });
  const inboxUpload = multer({
    storage: tmpStorage,
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
   * True when the real location of `resolved`'s parent folder is inside the real project folder.
   * resolveSafe compares text only, so a symlinked folder inside the project could lead outside it.
   * The item itself may be a symlink (delete and rename act on the link, not its target).
   */
  function parentInsideRealRoot(workingDir: string, resolved: string): boolean {
    try {
      const root = fs.realpathSync(path.resolve(workingDir));
      const parent = fs.realpathSync(path.dirname(resolved));
      const rel = path.relative(root, parent);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    } catch { return false; }
  }

  /** True when `resolved` is the working directory itself (delete and rename refuse it). */
  function isRoot(workingDir: string, resolved: string): boolean {
    return resolved === path.resolve(workingDir);
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
    const requestedPath = queryPath(req.query.path) || '.';
    if (req.query.path !== undefined && queryPath(req.query.path) === undefined) return res.status(400).json({ error: 'invalid path parameter' });
    const resolved = resolveSafe(session.workingDir, requestedPath);
    if (!resolved) return res.status(403).json({ error: 'Path traversal not allowed' });

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const result = entries.map(entry => {
        const abs = path.join(resolved, entry.name);
        const isDirectory = entry.isDirectory();
        // Size is best-effort decoration for the Files pane; a broken symlink or a
        // permission error must not fail the whole listing.
        let size: number | null = null;
        if (!isDirectory) { try { size = fs.statSync(abs).size; } catch { /* ignore */ } }
        return {
          name: entry.name,
          isDirectory,
          path: path.relative(session.workingDir, abs),
          size,
        };
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/sessions/:id/files/flat — every file path under the working dir, for search.
  // Inside a git repo the base set is `git ls-files` (tracked + untracked-but-not-ignored).
  // Gitignored paths the Files tree can still show are merged back in: hidden ones
  // (`.env`, `.dispatch/…`) and plain ignored files (a `.git/info/exclude`d scratchpad/
  // is the recommended way to keep agent scratch files out of commits, and it must stay
  // searchable). node_modules-class dirs and nested worktrees are still skipped so they
  // cannot blow the cap. Outside git it falls back to a bounded fs walk.
  router.get('/flat', async (req, res) => {
    const session = (req as any).session;
    try {
      const files = await gitLsFiles(session.workingDir, ['--cached', '--others', '--exclude-standard']);
      if (files) {
        const ignored = await gitLsFiles(session.workingDir, ['--others', '--ignored', '--exclude-standard']) ?? [];
        const seen = new Set(files);
        const gitCache = new Map<string, boolean>();
        let truncated = files.length > FLAT_CAP;
        for (const p of ignored) {
          if (seen.has(p) || hasSkippedSegment(p)) continue;
          if (underNestedGit(session.workingDir, p, gitCache)) continue;
          // Stop at the cap: past it every path is sliced off anyway, and underNestedGit's
          // synchronous stats would only keep blocking the event loop.
          if (files.length >= FLAT_CAP) { truncated = true; break; }
          files.push(p);
          seen.add(p);
        }
        return res.json({ files: files.slice(0, FLAT_CAP), truncated });
      }
      // Non-git fallback: breadth-limited walk.
      const out: string[] = [];
      let truncated = false;
      const walk = (dir: string) => {
        if (out.length >= FLAT_CAP) { truncated = true; return; }
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (out.length >= FLAT_CAP) { truncated = true; return; }
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) { if (!FLAT_SKIP.has(e.name)) walk(abs); }
          else if (e.isFile()) out.push(path.relative(session.workingDir, abs));
        }
      };
      walk(path.resolve(session.workingDir));
      res.json({ files: out, truncated });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/sessions/:id/files/read?path=file.txt — read file
  router.get('/read', async (req, res) => {
    const session = (req as any).session;
    const requestedPath = queryPath(req.query.path);
    if (!requestedPath) return res.status(400).json({ error: 'Missing path parameter' });

    const resolved = resolveRead(session.workingDir, requestedPath);
    if (!resolved) return res.status(403).json({ error: 'Path traversal not allowed' });

    try {
      // Regular files only: a device or FIFO can fill memory or block forever. Open without blocking,
      // then check the OPEN descriptor (not the path), so a swap after the check changes nothing, and
      // read at most the cap plus one byte so a file that grows meanwhile is still bounded.
      const fh = await fs.promises.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      try {
        const st = await fh.stat();
        if (!st.isFile()) return res.status(400).json({ error: 'Not a regular file' });
        if (st.size > MAX_READ_BYTES) return res.status(413).json({ error: `File is larger than ${MAX_READ_BYTES / (1024 * 1024)} MB` });
        const buf = Buffer.alloc(MAX_READ_BYTES + 1);
        let n = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, n, buf.length - n, null);
          if (bytesRead === 0) break;
          n += bytesRead;
          if (n > MAX_READ_BYTES) return res.status(413).json({ error: `File is larger than ${MAX_READ_BYTES / (1024 * 1024)} MB` });
        }
        res.json({ content: buf.toString('utf-8', 0, n), path: requestedPath });
      } finally { await fh.close(); }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/sessions/:id/files/image?path=img.png — stream raw image bytes
  // Additive sibling of /read for binary images (an <img src> can't consume the JSON
  // /read returns). Uses the STRICT resolveSafe sandbox (NOT resolveRead's absolute-path
  // escape hatch): permits in-tree paths like .dispatch/inbox, rejects anything outside
  // the working dir. Content-Type is chosen by extension; non-image extensions are
  // refused so this can't be repurposed to exfiltrate arbitrary file types.
  const IMAGE_MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
  };
  router.get('/image', (req, res) => {
    const session = (req as any).session;
    const requestedPath = queryPath(req.query.path);
    if (!requestedPath) return res.status(400).json({ error: 'Missing path parameter' });

    const resolved = resolveSafe(session.workingDir, requestedPath);
    if (!resolved) return res.status(403).json({ error: 'Path traversal not allowed' });

    const mime = IMAGE_MIME[path.extname(resolved).toLowerCase()];
    if (!mime) return res.status(415).json({ error: 'Unsupported image type' });

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return res.status(404).json({ error: 'Not a file' });
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', String(stat.size));
      // Hardening: stop MIME sniffing, and sandbox the response so a (theoretically)
      // script-bearing SVG can't execute if the byte URL is navigated to directly.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', 'sandbox');
      const stream = fs.createReadStream(resolved);
      stream.on('error', () => { if (!res.headersSent) res.status(400).end(); else res.destroy(); });
      stream.pipe(res);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  // GET /api/sessions/:id/files/download?path=file.ext — stream any file as a download.
  // Binary-safe sibling of /read (text-only JSON) and /image (inline images only): forces a
  // browser "Save As"/download of ANY file type via Content-Disposition: attachment. Uses the
  // STRICT resolveSafe sandbox — same guard as the directory listing this is triggered from.
  router.get('/download', (req, res) => {
    const session = (req as any).session;
    const requestedPath = queryPath(req.query.path);
    if (!requestedPath) return res.status(400).json({ error: 'Missing path parameter' });

    const resolved = resolveSafe(session.workingDir, requestedPath);
    if (!resolved) return res.status(403).json({ error: 'Path traversal not allowed' });

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return res.status(404).json({ error: 'Not a file' });

      const name = path.basename(resolved);
      // Sanitize for the header: drop anything outside printable ASCII (this also kills CR/LF
      // header injection) plus quotes/backslashes; the real name rides the RFC 5987 field.
      const asciiName = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      const stream = fs.createReadStream(resolved);
      stream.on('error', () => { if (!res.headersSent) res.status(400).end(); else res.destroy(); });
      stream.pipe(res);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  // POST /api/sessions/:id/files/reveal — select the given paths in the host's native file
  // manager (Finder on macOS, File Explorer under WSL; unsupported on headless Linux).
  //
  // Only ever valid when the browser is on the SAME machine as the daemon: on a headless box
  // this would pop a file manager on a screen nobody is looking at. The guard below reads the
  // unforgeable socket peer address (NOT req.ip, which trusts X-Forwarded-For), plus the Host
  // header and the proxy headers — because a same-host reverse proxy (cloudflared,
  // `tailscale serve`) makes every remote visitor arrive over loopback. The client's menu
  // already hides this item — this check is the one that actually enforces it.
  //
  // Revealing the whole selection at once is deliberate where the platform supports it: Finder
  // opens with all of them selected, and Finder's Cmd-C *does* paste into a browser upload field
  // — which a web page's own clipboard can never do for arbitrary file types.
  router.post('/reveal', async (req, res) => {
    if (!(platform.fileManagerName !== null && platform.isLocalClient(revealClientFrom(req)))) {
      return res.status(403).json({ error: 'Reveal is only available on the machine running Dispatch' });
    }
    const session = (req as any).session;
    const paths = req.body?.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'Missing paths' });
    }
    if (paths.length > MAX_REVEAL_PATHS) {
      return res.status(400).json({ error: `Too many paths (max ${MAX_REVEAL_PATHS})` });
    }

    const resolved: string[] = [];
    for (const p of paths) {
      const abs = typeof p === 'string' ? resolveSafe(session.workingDir, p) : null;
      if (!abs) return res.status(403).json({ error: 'Path traversal not allowed' });
      resolved.push(abs);
    }

    try {
      await platform.revealInFileManager(resolved);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/sessions/:id/files/write?path=file.txt — write file
  router.put('/write', (req, res) => {
    const session = (req as any).session;
    const requestedPath = queryPath(req.query.path);
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
  router.post('/upload', (req, res) => {
    upload.single('file')(req, res, (uploadErr: any) => {
      if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
        unlinkQuiet((req as any).uploadTmpPath);
        return res.status(413).json({ error: `File is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB` });
      }
      if (uploadErr) { unlinkQuiet((req as any).uploadTmpPath); return res.status(400).json({ error: uploadErr.message }); }

      const session = (req as any).session;
      const tmpFile = req.file?.path;
      const requestedPath = queryPath(req.query.path) || '.';
      const resolved = resolveSafe(session.workingDir, requestedPath);
      if (!resolved) { unlinkQuiet(tmpFile); return res.status(403).json({ error: 'Path traversal not allowed' }); }

      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      try {
        const dest = path.join(resolved, req.file.originalname);
        if (!dest.startsWith(session.workingDir)) { unlinkQuiet(tmpFile); return res.status(403).json({ error: 'Path traversal not allowed' }); }
        fs.copyFileSync(req.file.path, dest);
        fs.unlinkSync(req.file.path);
        res.json({ ok: true, path: path.relative(session.workingDir, dest) });
      } catch (err: any) {
        unlinkQuiet(tmpFile);
        res.status(400).json({ error: err.message });
      }
    });
  });

  // POST /api/sessions/:id/files/inbox — upload file into .dispatch/inbox
  router.post('/inbox', (req, res) => {
    inboxUpload.single('file')(req, res, (err: any) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        unlinkQuiet((req as any).uploadTmpPath);
        return res.status(413).json({ error: 'File is larger than 50 MB' });
      }
      if (err) { unlinkQuiet((req as any).uploadTmpPath); return res.status(400).json({ error: err.message }); }

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
    const requestedPath = queryPath(req.query.path);
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
    const fromPath = req.body?.from as string;
    const toPath = req.body?.to as string;
    if (!fromPath || !toPath) return res.status(400).json({ error: 'Missing from or to path' });

    const from = resolveSafe(session.workingDir, fromPath);
    const to = resolveSafe(session.workingDir, toPath);
    if (!from || !to) return res.status(403).json({ error: 'Path traversal not allowed' });
    if (isRoot(session.workingDir, from) || isRoot(session.workingDir, to)) {
      return res.status(400).json({ error: 'Cannot rename the project folder' });
    }
    if (!parentInsideRealRoot(session.workingDir, from) || !parentInsideRealRoot(session.workingDir, to)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

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
    const requestedPath = queryPath(req.query.path);
    if (!requestedPath) return res.status(400).json({ error: 'Missing path parameter' });

    const resolved = resolveSafe(session.workingDir, requestedPath);
    if (!resolved) return res.status(403).json({ error: 'Path traversal not allowed' });
    if (isRoot(session.workingDir, resolved)) return res.status(400).json({ error: 'Cannot delete the project folder' });
    if (!parentInsideRealRoot(session.workingDir, resolved)) return res.status(403).json({ error: 'Path traversal not allowed' });

    try {
      fs.rmSync(resolved, { recursive: true });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
