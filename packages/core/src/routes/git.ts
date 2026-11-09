import { execFile } from 'child_process';
import os from 'node:os';
import type { Request, Response, Router } from 'express';
import { policyRouter, ownerOnlyStrict } from '../auth/route-policy.js';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { rowToSession } from '../types.js';
import { GIT_NO_FSMONITOR } from '../docs/git.js';
import { platform } from '../platform/index.js';
import { defaultSecretRoots, type SecretRoots } from '../files/secret-paths.js';
import { threadDiff } from '../git/diff.js';
import { approvePaths, discardPaths } from '../git/apply.js';
import { PathRefused } from '../git/paths.js';
import { createThreadWorktree, listThreadWorktrees, removeThreadWorktree, WorktreeError } from '../git/worktree.js';

export interface GitChangedFile { path: string; status: string }

/**
 * Parse `git status --porcelain -z` output. -z is the only mode where paths are
 * verbatim (no quoting of spaces/unicode): records are NUL-terminated, and a
 * rename/copy record is followed by ONE extra NUL-terminated field (the old path),
 * which must be consumed or it would be misread as the next record.
 */
export function parsePorcelainZ(out: string): GitChangedFile[] {
  const fields = out.split('\0');
  const files: GitChangedFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec.length < 4) continue; // "XY path" needs at least 2 status chars + space + 1 char
    const x = rec[0], y = rec[1];
    const p = rec.slice(3);
    if (x === 'R' || x === 'C') i++; // skip the old path field
    // One letter for the UI column: untracked '?', staged-new 'A', deletions 'D',
    // renames 'R', everything else (modified either side) 'M'.
    const status =
      x === '?' ? '?' :
      x === 'A' ? 'A' :
      x === 'D' || y === 'D' ? 'D' :
      x === 'R' || x === 'C' ? 'R' : 'M';
    files.push({ path: p, status });
  }
  return files;
}

/** The cap on patch text for one file asked for by `?path=` (the list uses the default of git/diff.ts). */
const ONE_FILE_MAX_BYTES = 2 * 1024 * 1024;

const expandHome = (dir: string): string => dir.replace(/^~(?=$|\/)/, os.homedir());

/**
 * The working directories of the live agent threads, one entry for each thread, over every project (two projects can
 * name one folder). Archived threads, plain shells and the non-thread tabs do not count.
 */
function liveThreadDirs(db: Database.Database): string[] {
  const rows = db.prepare(
    'SELECT t.type AS type, t.working_dir AS wd, s.working_dir AS sd FROM terminals t JOIN sessions s ON s.id = t.session_id WHERE t.archived_at IS NULL',
  ).all() as Array<{ type: string; wd: string | null; sd: string }>;
  return rows.filter((r) => terminalsDb.isPtyType(r.type) && r.type !== 'shell').map((r) => expandHome(r.wd || r.sd));
}

/**
 * The directory a review acts on: the thread's own working directory (a worktree, when it has one), or the project's
 * when no thread is named. A thread of another project answers 404, so one project's route never reaches another's files.
 */
function reviewDir(db: Database.Database, req: Request, res: Response, terminalId: unknown): string | null {
  const row = sessionsDb.getById(db, (req.params as { id?: string }).id ?? '');
  if (!row) { res.status(404).json({ error: 'Session not found' }); return null; }
  const session = rowToSession(row);
  if (terminalId === undefined || terminalId === null || terminalId === '') return expandHome(session.workingDir);
  const t = typeof terminalId === 'string' ? terminalsDb.getById(db, terminalId) : null;
  if (!t || t.session_id !== session.id) { res.status(404).json({ error: 'Thread not found in this project' }); return null; }
  return expandHome(t.working_dir || session.workingDir);
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof PathRefused) return void res.status(err.status).json({ error: err.message });
  if (err instanceof WorktreeError) {
    const status = err.code === 'not_a_repo' || err.code === 'no_commit' ? 400 : err.code === 'not_a_worktree' ? 403 : err.code === 'dirty' || err.code === 'in_use' ? 409 : 500;
    return void res.status(status).json({ error: err.message, code: err.code });
  }
  res.status(500).json({ error: err instanceof Error ? err.message : 'git failed' });
}

export function createGitRouter(db: Database.Database, opts: { secretRoots?: SecretRoots } = {}): Router {
  const router = policyRouter({ mergeParams: true });
  const secretRoots = opts.secretRoots ?? defaultSecretRoots(platform.dataDir());

  // ── Diff review (engineering program W3-G) ──────────────────────────────────────────────────────────────

  // GET /api/sessions/:id/git/diff?terminalId=&path= — the thread directory against HEAD, untracked files listed.
  router.get('/diff', async (req, res) => {
    const dir = reviewDir(db, req, res, req.query.terminalId);
    if (dir === null) return;
    const one = typeof req.query.path === 'string' && req.query.path !== '' ? req.query.path : undefined;
    try {
      res.json(await threadDiff(dir, { liveDirs: liveThreadDirs(db), secretRoots, ...(one !== undefined ? { path: one, maxBytes: ONE_FILE_MAX_BYTES } : {}) }));
    } catch (err) { sendError(res, err); }
  });

  // POST /api/sessions/:id/git/approve { terminalId, paths } — `git add` on the listed files. No commit.
  // Strict like discard: an agent with a plain local HTTP call must not approve its own work.
  router.post('/approve', ownerOnlyStrict, async (req, res) => {
    const dir = reviewDir(db, req, res, req.body?.terminalId);
    if (dir === null) return;
    try { res.json(await approvePaths(dir, req.body?.paths, secretRoots)); } catch (err) { sendError(res, err); }
  });

  // POST /api/sessions/:id/git/discard { terminalId, paths } — a tracked file goes back to HEAD, a new file is
  // removed. Only the listed files; see git/apply.ts for the rules. The page asks first and names each file.
  router.post('/discard', ownerOnlyStrict, async (req, res) => {
    const dir = reviewDir(db, req, res, req.body?.terminalId);
    if (dir === null) return;
    try { res.json(await discardPaths(dir, req.body?.paths, secretRoots)); } catch (err) { sendError(res, err); }
  });

  // GET /api/sessions/:id/git — current branch for the session's working dir
  router.get('/', (req, res) => {
    const row = sessionsDb.getById(db, (req.params as any).id);
    if (!row) return res.status(404).json({ error: 'Session not found' });
    const session = rowToSession(row);
    execFile(
      'git',
      ['-C', session.workingDir, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) return res.json({ branch: null });
        res.json({ branch: stdout.trim() || null });
      },
    );
  });

  // GET /api/sessions/:id/git/status — branch + working-tree changes for the Files pane.
  // Non-git directories are not an error: they answer { branch: null, files: [] } so the
  // client can simply hide the git affordances.
  router.get('/status', (req, res) => {
    const row = sessionsDb.getById(db, (req.params as any).id);
    if (!row) return res.status(404).json({ error: 'Session not found' });
    const session = rowToSession(row);
    execFile(
      'git',
      ['-C', session.workingDir, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 3000 },
      (branchErr, branchOut) => {
        if (branchErr) return res.json({ branch: null, files: [] });
        const branch = branchOut.trim() || null;
        // -uall: list each untracked FILE. By default porcelain collapses an untracked
        // directory into one `dir/` record, which the Files pane cannot open (clicking it
        // read a directory into an empty editor). The per-file paths stay repo-root-
        // relative like every other record, even when workingDir is a subdirectory.
        execFile(
          'git',
          [...GIT_NO_FSMONITOR, '-C', session.workingDir, 'status', '--porcelain', '-z', '-uall'],
          { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout) => {
            if (err) return res.json({ branch, files: [] });
            res.json({ branch, files: parsePorcelainZ(stdout) });
          },
        );
      },
    );
  });

  return router;
}

/**
 * Worktrees for threads (engineering program W3-G), mounted at /api/sessions/:id/worktrees.
 * The path that POST returns goes to the `workingDir` of thread creation.
 */
export function createWorktreesRouter(db: Database.Database): Router {
  const router = policyRouter({ mergeParams: true });

  // GET — the worktrees Dispatch made for this project, with `dirty` (uncommitted work) and `inUse` (a live thread).
  router.get('/', async (req, res) => {
    const dir = reviewDir(db, req, res, undefined);
    if (dir === null) return;
    try { res.json({ worktrees: await listThreadWorktrees(dir, { liveDirs: liveThreadDirs(db) }) }); } catch (err) { sendError(res, err); }
  });

  // POST { name? } — `git worktree add <project>/.claude/worktrees/<slug> -b dispatch/<slug>` from the current HEAD.
  router.post('/', ownerOnlyStrict, async (req, res) => {
    const dir = reviewDir(db, req, res, undefined);
    if (dir === null) return;
    const name = typeof req.body?.name === 'string' ? req.body.name : undefined;
    try { res.json(await createThreadWorktree(dir, { name })); } catch (err) { sendError(res, err); }
  });

  // POST /remove { path } — only a worktree with no uncommitted work and no live thread. The branch stays.
  router.post('/remove', ownerOnlyStrict, async (req, res) => {
    const dir = reviewDir(db, req, res, undefined);
    if (dir === null) return;
    try { res.json(await removeThreadWorktree(dir, req.body?.path, { liveDirs: liveThreadDirs(db) })); } catch (err) { sendError(res, err); }
  });

  return router;
}
