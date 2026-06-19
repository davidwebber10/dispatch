import { execFile } from 'child_process';
import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as sessionsDb from '../db/sessions.js';
import { rowToSession } from '../types.js';

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

  return router;
}
