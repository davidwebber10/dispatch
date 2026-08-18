import { execFile } from 'child_process';
import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import { rowToSession } from '../types.js';

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

export function createGitRouter(db: Database.Database): Router {
  const router = Router({ mergeParams: true });

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
        execFile(
          'git',
          ['-C', session.workingDir, 'status', '--porcelain', '-z'],
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
