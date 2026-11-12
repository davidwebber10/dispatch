import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import type { Router } from 'express';
import { policyRouter } from '../auth/route-policy.js';
import multer from 'multer';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import { rowToSession } from '../types.js';
import { revealClientFrom } from '../files/reveal.js';
import { platform } from '../platform/index.js';
import { insideRealRoot, within } from '../files/confine.js';
import { openInside } from '../files/confinedOpen.js';
import { clientMessage } from '../http/client-message.js';
import { GIT_NO_FSMONITOR } from '../docs/git.js';
import { defaultSecretRoots, holdsSecret, isSecretPath, SECRET_PATH_ERROR, type SecretRoots } from '../files/secret-paths.js';
import { PATH_REFUSALS, realAsFarAsItExists, type FileUse, type PathPolicy } from '../files/path-policy.js';
import { pathPolicyFor } from '../files/path-policy-default.js';

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

/**
 * A client that drops the connection part way through an upload never gets multer's callback, so the
 * half-written temp file is removed here: when the connection closes before a response went out. A second
 * pass catches a file that multer created just after the close.
 */
function cleanupOnAbort(req: import('express').Request, res: import('express').Response): void {
  // The RESPONSE closing without having finished means the client went away (req 'close' also fires
  // when the body has simply been read in full).
  res.on('close', () => {
    if (res.writableFinished) return;
    (req as any).uploadCancelled = true;
    // First through the storage engine, so multer sees an error, not a finished file.
    try { (req as any).uploadAbort?.(); } catch { /* already settled */ }
    const file = (req as any).uploadTmpPath as string | undefined;
    // Close the descriptor and the incoming stream, then remove the half-written file.
    for (const st of ((req as any).uploadStreams ?? []) as Array<{ destroy: () => void }>) { try { st.destroy(); } catch { /* already closed */ } }
    unlinkQuiet(file);
    setTimeout(() => unlinkQuiet(file), 2000).unref();
  });
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
      [...GIT_NO_FSMONITOR, '-C', workingDir, 'ls-files', ...extraArgs, '-z'],
      { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout.split('\0').filter(Boolean)),
    );
  });
}

// Like multer's disk storage, but the write stream and the incoming stream are kept on the request
// so an aborted upload can close both (multer never calls back when the client just goes away, and
// would leave the descriptor open until the daemon exits).
export const uploadStorage: multer.StorageEngine = {
  _handleFile(req, file, cb) {
    let tmpPath: string;
    try {
      ensureUploadDir();
      tmpPath = path.join(UPLOAD_TMP_DIR, `up-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    } catch (err) { cb(err as Error); return; }
    const out = fs.createWriteStream(tmpPath, { mode: 0o600 });
    // Kept on the request from creation, so a write that fails half way can still be removed.
    Object.assign(req, { uploadTmpPath: tmpPath, uploadStreams: [out, file.stream] });
    // One answer to multer, whichever event comes first. A failure closes both streams and removes the
    // file; the file may not exist yet if the open is still pending, so it is removed again on close.
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      out.destroy();
      file.stream.destroy();
      unlinkQuiet(tmpPath);
      out.once('close', () => unlinkQuiet(tmpPath));
      cb(err);
    };
    // A cancel is a failure, whatever the streams look like: a writer destroyed before it finished
    // still emits 'close', and that must not be mistaken for a finished upload.
    const abort = () => fail(new Error('upload cancelled'));
    (req as any).uploadAborts = [...(((req as any).uploadAborts as Array<() => void>) ?? []), abort];
    (req as any).uploadAbort = () => { for (const a of (req as any).uploadAborts as Array<() => void>) a(); };
    file.stream.on('error', fail);
    out.on('error', fail);
    // 'close', not 'finish': the descriptor is released and a late close error is still an error.
    out.on('close', () => {
      if (settled) return;
      settled = true;
      cb(null, { destination: UPLOAD_TMP_DIR, filename: path.basename(tmpPath), path: tmpPath, size: out.bytesWritten });
    });
    file.stream.pipe(out);
  },
  _removeFile(_req, file, cb) {
    // multer can call this for a file that never got a path (a failed write after a size-limit stop).
    const p = (file as { path?: string }).path;
    if (!p) { cb(null); return; }
    fs.unlink(p, (err) => cb(err && (err as NodeJS.ErrnoException).code !== 'ENOENT' ? err : null));
  },
};

export function createFilesRouter(db: Database.Database, opts: { secretRoots?: SecretRoots; policy?: PathPolicy } = {}): Router {
  const router = policyRouter({ mergeParams: true });
  // The credential deny-list of the read route (files/secret-paths.ts). A test gives its own roots.
  const secretRoots = opts.secretRoots ?? defaultSecretRoots(platform.dataDir());
  // Which folders a path may be in at all (files/path-policy.ts): never the system's own trees; on a
  // hosted box only the person's folders; for a business person only the project, without the folders
  // that configure an agent program. EVERY route below asks it for every path it touches.
  const policy = opts.policy ?? pathPolicyFor(db);
  /** Sends the refusal and answers true when `resolved` may not be touched. */
  const refused = (res: import('express').Response, session: { workingDir: string }, resolved: string, use: FileUse, self = false): boolean => {
    const why = policy.problem(resolved, { project: session.workingDir, use, self });
    if (!why) return false;
    res.status(403).json({ error: PATH_REFUSALS[why], code: 'path_refused', reason: why });
    return true;
  };
  /** The same for a file that is open, or that a write would replace: a file with more than one name (hosted). */
  const refusedOpen = (res: import('express').Response, st: fs.Stats, realPath: string): boolean => {
    const why = policy.openedProblem(st, realPath);
    if (!why) return false;
    res.status(403).json({ error: PATH_REFUSALS[why], code: 'path_refused', reason: why });
    return true;
  };
  // Recreate the temp dir on EVERY request, not once at startup (multer's `dest`
  // shorthand): macOS purges /tmp entries idle for ~3 days, so on a long-running
  // daemon the dir vanishes mid-uptime and every upload then fails with ENOENT
  // until a restart.
  const upload = multer({ storage: uploadStorage, limits: { fileSize: MAX_UPLOAD_BYTES } });
  const inboxUpload = multer({
    storage: uploadStorage,
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
    return insideRealRoot(workingDir, path.dirname(resolved));
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
    if (!insideRealRoot(session.workingDir, resolved)) return res.status(403).json({ error: 'Path traversal not allowed' });
    if (refused(res, session, resolved, 'read')) return;

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
        .filter((entry) => !policy.hiddenInListing(path.relative(session.workingDir, path.join(resolved, entry.name))));
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
      res.status(400).json({ error: clientMessage(err) });
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
    if (refused(res, session, path.resolve(session.workingDir), 'read')) return;
    const shown = (list: string[]): string[] => list.filter((p) => !policy.hiddenInListing(p));
    try {
      const listed = await gitLsFiles(session.workingDir, ['--cached', '--others', '--exclude-standard']);
      const files = listed ? shown(listed) : null;
      if (files) {
        const ignored = await gitLsFiles(session.workingDir, ['--others', '--ignored', '--exclude-standard']) ?? [];
        const seen = new Set(files);
        const gitCache = new Map<string, boolean>();
        let truncated = files.length > FLAT_CAP;
        for (const p of ignored) {
          if (seen.has(p) || hasSkippedSegment(p) || policy.hiddenInListing(p)) continue;
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
      res.json({ files: shown(out), truncated });
    } catch (err: any) {
      res.status(400).json({ error: clientMessage(err) });
    }
  });

  // GET /api/sessions/:id/files/read?path=file.txt — read file
  router.get('/read', async (req, res) => {
    const session = (req as any).session;
    const requestedPath = queryPath(req.query.path);
    if (!requestedPath) return res.status(400).json({ error: 'Missing path parameter' });

    const resolved = resolveRead(session.workingDir, requestedPath);
    if (!resolved) return res.status(403).json({ error: 'Path traversal not allowed' });
    // An absolute path to a place outside the project is the documented read escape hatch. A relative path, or an
    // absolute path that names a place inside the project, stays in the project, symlinks included: a link inside the
    // project cannot be a way to a file outside it.
    const named = !path.isAbsolute(requestedPath) || within(path.resolve(session.workingDir), resolved);
    if (named && !insideRealRoot(session.workingDir, resolved)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }
    // The person's folders only (files/path-policy.ts): never /proc and the like; on a hosted box the
    // "View file" way out of the project ends at the home folder (developer) or does not exist (business).
    if (refused(res, session, resolved, 'read')) return;

    // Credentials are never served, to any caller (the owner too). The check is on the REAL path, so a symbolic link
    // cannot go around it; the path as written is checked as well, so a name in a secret folder gets the same answer
    // whether the file exists or not.
    let real: string | null = null;
    try { real = await fs.promises.realpath(resolved); } catch { /* missing or unreadable: the open below reports it */ }
    if (isSecretPath(resolved, secretRoots) || (real !== null && isSecretPath(real, secretRoots))) {
      return res.status(403).json({ error: SECRET_PATH_ERROR });
    }

    try {
      // Regular files only: a device or FIFO can fill memory or block forever. Open without blocking,
      // then check the OPEN descriptor (not the path), and read at most the cap plus one byte so a file that
      // grows meanwhile is still bounded.
      // A path that is checked against the project (`named`) goes through openInside: it is opened by its real path with
      // O_NOFOLLOW, every folder on the way is pinned and looked at again after the open, and the descriptor must be the
      // file at that path. A link or a folder swapped in after the containment check is not followed. The limit is
      // written in files/confinedOpen.ts (no fd-anchored walk exists in Node).
      let fh: fs.promises.FileHandle;
      let st: fs.Stats;
      if (named) {
        const o = await openInside(session.workingDir, resolved);
        if (o.kind === 'outside') return res.status(403).json({ error: 'Path traversal not allowed' });
        if (o.kind === 'missing') throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
        fh = o.fh;
        st = o.st;
      } else {
        // Open the real path that was just checked, and do not follow a link at its last part: a link put there after
        // the check is refused (ELOOP), not read.
        fh = real !== null
          ? await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW)
          : await fs.promises.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        st = await fh.stat();
      }
      try {
        // The identity of the OPEN file (v4.5.0 review, I4): a hard link to a secret, or a second mount path to it,
        // has a text that the check above does not know. No byte of such a file is read.
        if (await holdsSecret(real ?? resolved, secretRoots, fh)) return res.status(403).json({ error: SECRET_PATH_ERROR });
        if (!st.isFile()) return res.status(400).json({ error: 'Not a regular file' });
        if (refusedOpen(res, st, real ?? resolved)) return;
        // ?sniff=1 (file chips): read the first 8 KB only and say whether the file is binary (it has a NUL byte).
        // The chip downloads such a file instead of opening it as text. No content comes back.
        if (req.query.sniff === '1') {
          const probe = Buffer.alloc(8192);
          const { bytesRead } = await fh.read(probe, 0, probe.length, 0);
          return res.json({ content: '', path: requestedPath, binary: probe.subarray(0, bytesRead).includes(0) });
        }
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
      res.status(400).json({ error: clientMessage(err) });
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
  // Credentials are never served by any file route (W1-B for /read; /image and /download since the Wave 1
  // integration). Before the open, the path as written and the real path are both checked, so a link cannot go
  // around it and a missing file in a secret folder gets the same answer. After the open, `holdsSecret` checks the
  // identity of the open file (v4.5.0 review, I4): a hard link and a second mount path cannot go around it.
  const namesSecret = async (resolved: string): Promise<boolean> => {
    if (isSecretPath(resolved, secretRoots)) return true;
    try { return isSecretPath(await fs.promises.realpath(resolved), secretRoots); } catch { return false; }
  };

  router.get('/image', async (req, res) => {
    const session = (req as any).session;
    const requestedPath = queryPath(req.query.path);
    if (!requestedPath) return res.status(400).json({ error: 'Missing path parameter' });

    const resolved = resolveSafe(session.workingDir, requestedPath);
    if (!resolved) return res.status(403).json({ error: 'Path traversal not allowed' });

    const mime = IMAGE_MIME[path.extname(resolved).toLowerCase()];
    if (!mime) return res.status(415).json({ error: 'Unsupported image type' });
    if (!insideRealRoot(session.workingDir, resolved)) return res.status(403).json({ error: 'Path traversal not allowed' });
    if (await namesSecret(resolved)) return res.status(403).json({ error: SECRET_PATH_ERROR });
    if (refused(res, session, resolved, 'read')) return;

    try {
      // The bytes come from the descriptor openInside checked, never from a second look at the path.
      const o = await openInside(session.workingDir, resolved);
      if (o.kind === 'outside') return res.status(403).json({ error: 'Path traversal not allowed' });
      if (o.kind === 'missing') return res.status(404).json({ error: 'File not found' });
      if (!o.st.isFile()) { await o.fh.close().catch(() => {}); return res.status(404).json({ error: 'Not a file' }); }
      if (await holdsSecret(resolved, secretRoots, o.fh).catch(() => true)) { await o.fh.close().catch(() => {}); return res.status(403).json({ error: SECRET_PATH_ERROR }); }
      if (refusedOpen(res, o.st, resolved)) { await o.fh.close().catch(() => {}); return; }
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', String(o.st.size));
      // Hardening: stop MIME sniffing, and sandbox the response so a (theoretically)
      // script-bearing SVG can't execute if the byte URL is navigated to directly.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', 'sandbox');
      const stream = o.fh.createReadStream({ autoClose: true });
      stream.on('error', () => { if (!res.headersSent) res.status(400).end(); else res.destroy(); });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (err: any) {
      res.status(404).json({ error: clientMessage(err) });
    }
  });

  // GET /api/sessions/:id/files/download?path=file.ext — stream any file as a download.
  // Binary-safe sibling of /read (text-only JSON) and /image (inline images only): forces a
  // browser "Save As"/download of ANY file type via Content-Disposition: attachment. Uses the
  // STRICT resolveSafe sandbox — same guard as the directory listing this is triggered from.
  router.get('/download', async (req, res) => {
    const session = (req as any).session;
    const requestedPath = queryPath(req.query.path);
    if (!requestedPath) return res.status(400).json({ error: 'Missing path parameter' });

    const resolved = resolveSafe(session.workingDir, requestedPath);
    if (!resolved) return res.status(403).json({ error: 'Path traversal not allowed' });
    if (!insideRealRoot(session.workingDir, resolved)) return res.status(403).json({ error: 'Path traversal not allowed' });
    if (await namesSecret(resolved)) return res.status(403).json({ error: SECRET_PATH_ERROR });
    if (refused(res, session, resolved, 'read')) return;

    try {
      // The bytes come from the descriptor openInside checked, never from a second look at the path.
      const o = await openInside(session.workingDir, resolved);
      if (o.kind === 'outside') return res.status(403).json({ error: 'Path traversal not allowed' });
      if (o.kind === 'missing') return res.status(404).json({ error: 'File not found' });
      if (!o.st.isFile()) { await o.fh.close().catch(() => {}); return res.status(404).json({ error: 'Not a file' }); }
      if (await holdsSecret(resolved, secretRoots, o.fh).catch(() => true)) { await o.fh.close().catch(() => {}); return res.status(403).json({ error: SECRET_PATH_ERROR }); }
      if (refusedOpen(res, o.st, resolved)) { await o.fh.close().catch(() => {}); return; }

      const name = path.basename(resolved);
      // Sanitize for the header: drop anything outside printable ASCII (this also kills CR/LF
      // header injection) plus quotes/backslashes; the real name rides the RFC 5987 field.
      const asciiName = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(o.st.size));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // A download is never a page: if a browser shows it anyway, it runs nothing and belongs to no origin.
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      const stream = o.fh.createReadStream({ autoClose: true });
      stream.on('error', () => { if (!res.headersSent) res.status(400).end(); else res.destroy(); });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (err: any) {
      res.status(404).json({ error: clientMessage(err) });
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
      if (refused(res, session, abs, 'read')) return;
      resolved.push(abs);
    }

    try {
      await platform.revealInFileManager(resolved);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: clientMessage(err) });
    }
  });

  // PUT /api/sessions/:id/files/write?path=file.txt — write file
  router.put('/write', (req, res) => {
    const session = (req as any).session;
    const requestedPath = queryPath(req.query.path);
    if (!requestedPath) return res.status(400).json({ error: 'Missing path parameter' });

    const resolved = resolveSafe(session.workingDir, requestedPath);
    if (!resolved) return res.status(403).json({ error: 'Path traversal not allowed' });
    if (!insideRealRoot(session.workingDir, resolved)) return res.status(403).json({ error: 'Path traversal not allowed' });
    if (refused(res, session, resolved, 'write')) return;
    // Credentials are never written through a file route either: a path in a secret folder, or a file
    // that IS a secret under another name (a hard link), is refused like a read of it.
    if (isSecretPath(resolved, secretRoots) || isSecretPath(realAsFarAsItExists(resolved), secretRoots)) return res.status(403).json({ error: SECRET_PATH_ERROR });

    try {
      let existing: fs.Stats | null = null;
      try { existing = fs.statSync(resolved); } catch { /* a new file */ }
      if (existing && refusedOpen(res, existing, realAsFarAsItExists(resolved))) return;
      fs.writeFileSync(resolved, req.body.content);
      res.json({ ok: true, path: requestedPath });
    } catch (err: any) {
      res.status(400).json({ error: clientMessage(err) });
    }
  });

  // POST /api/sessions/:id/files/upload — upload file
  router.post('/upload', (req, res) => {
    cleanupOnAbort(req, res);
    upload.single('file')(req, res, (uploadErr: any) => {
      if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
        unlinkQuiet((req as any).uploadTmpPath);
        return res.status(413).json({ error: `File is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB` });
      }
      if (uploadErr) { unlinkQuiet((req as any).uploadTmpPath); return res.status(400).json({ error: clientMessage(uploadErr) }); }

      const session = (req as any).session;
      const tmpFile = req.file?.path;
      if ((req as any).uploadCancelled) { unlinkQuiet(tmpFile); return; }
      const requestedPath = queryPath(req.query.path) || '.';
      const resolved = resolveSafe(session.workingDir, requestedPath);
      if (!resolved) { unlinkQuiet(tmpFile); return res.status(403).json({ error: 'Path traversal not allowed' }); }

      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      try {
        const dest = path.join(resolved, req.file.originalname);
        if (!dest.startsWith(session.workingDir) || !insideRealRoot(session.workingDir, dest)) { unlinkQuiet(tmpFile); return res.status(403).json({ error: 'Path traversal not allowed' }); }
        if (refused(res, session, dest, 'write')) { unlinkQuiet(tmpFile); return; }
        let existing: fs.Stats | null = null;
        try { existing = fs.statSync(dest); } catch { /* a new file */ }
        if (existing && refusedOpen(res, existing, realAsFarAsItExists(dest))) { unlinkQuiet(tmpFile); return; }
        fs.copyFileSync(req.file.path, dest);
        fs.unlinkSync(req.file.path);
        res.json({ ok: true, path: path.relative(session.workingDir, dest) });
      } catch (err: any) {
        unlinkQuiet(tmpFile);
        res.status(400).json({ error: clientMessage(err) });
      }
    });
  });

  // POST /api/sessions/:id/files/inbox — upload file into .dispatch/inbox
  router.post('/inbox', (req, res) => {
    cleanupOnAbort(req, res);
    inboxUpload.single('file')(req, res, (err: any) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        unlinkQuiet((req as any).uploadTmpPath);
        return res.status(413).json({ error: 'File is larger than 50 MB' });
      }
      if (err) { unlinkQuiet((req as any).uploadTmpPath); return res.status(400).json({ error: clientMessage(err) }); }

      const session = (req as any).session;
      if ((req as any).uploadCancelled) { unlinkQuiet(req.file?.path); return; }
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      try {
        const inboxDir = path.join(session.workingDir, '.dispatch', 'inbox');
        if (!insideRealRoot(session.workingDir, inboxDir)) { unlinkQuiet(req.file.path); return res.status(403).json({ error: 'Path traversal not allowed' }); }
        if (refused(res, session, inboxDir, 'write')) { unlinkQuiet(req.file.path); return; }
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
        res.status(400).json({ error: clientMessage(copyErr) });
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

    if (!insideRealRoot(session.workingDir, resolved)) return res.status(403).json({ error: 'Path traversal not allowed' });
    if (refused(res, session, resolved, 'write')) return;

    try {
      fs.mkdirSync(resolved, { recursive: true });
      res.json({ ok: true, path: requestedPath });
    } catch (err: any) {
      res.status(400).json({ error: clientMessage(err) });
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
    // The item itself may be a link (rename acts on the link, not on its target).
    if (refused(res, session, from, 'write', true) || refused(res, session, to, 'write', true)) return;

    try {
      fs.renameSync(from, to);
      res.json({ ok: true, path: path.relative(session.workingDir, to) });
    } catch (err: any) {
      res.status(400).json({ error: clientMessage(err) });
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
    if (refused(res, session, resolved, 'write', true)) return;

    try {
      fs.rmSync(resolved, { recursive: true });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: clientMessage(err) });
    }
  });

  return router;
}
