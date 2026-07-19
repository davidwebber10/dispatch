import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import * as watchesDb from '../db/watches.js';
import type { WatchRow } from '../db/watches.js';
import { MAX_LIVE_WATCHES_PER_WATCHER } from '../overseer/guards.js';

const VALID_CRITERIA: ReadonlySet<WatchRow['criteria']> = new Set(['idle', 'needs_input', 'error', 'any']);

/**
 * Watch subscriptions: a thread registers interest in a peer's status edges
 * (fired later by the watch dispatcher, Task 5). Every mutation is scoped to
 * the caller's project — watcher and target must share a session — so a
 * thread can never learn about or subscribe to a terminal outside its project.
 */
export function createWatchesRouter(db: Database.Database): Router {
  const router = Router();

  router.post('/', (req, res) => {
    const { watcherTerminalId, targetTerminalId, criteria, note, once } = req.body ?? {};

    if (!watcherTerminalId || !targetTerminalId || !criteria) {
      res.status(400).json({ error: 'watcherTerminalId, targetTerminalId, and criteria are required' });
      return;
    }
    if (!VALID_CRITERIA.has(criteria)) {
      res.status(400).json({ error: "criteria must be one of 'idle', 'needs_input', 'error', 'any'" });
      return;
    }

    const watcher = terminalsDb.getById(db, watcherTerminalId);
    if (!watcher) {
      res.status(404).json({ error: `unknown terminal: ${watcherTerminalId}` });
      return;
    }
    const target = terminalsDb.getById(db, targetTerminalId);
    if (!target) {
      res.status(404).json({ error: `unknown terminal: ${targetTerminalId}` });
      return;
    }
    if (watcher.session_id !== target.session_id) {
      res.status(400).json({ error: 'not in this project' });
      return;
    }

    if (watchesDb.countByWatcher(db, watcherTerminalId) >= MAX_LIVE_WATCHES_PER_WATCHER) {
      res.status(429).json({ error: `watcher already has ${MAX_LIVE_WATCHES_PER_WATCHER} live watches (max) — remove one before adding another` });
      return;
    }

    const id = watchesDb.create(db, { watcherTerminalId, targetTerminalId, criteria, note, once });
    res.status(201).json({ id });
  });

  router.get('/', (req, res) => {
    const watcher = typeof req.query.watcher === 'string' ? req.query.watcher : undefined;
    const target = typeof req.query.target === 'string' ? req.query.target : undefined;
    res.json({
      watching: watcher ? watchesDb.listByWatcher(db, watcher) : [],
      watchedBy: target ? watchesDb.listByTarget(db, target) : [],
    });
  });

  router.delete('/:id', (req, res) => {
    const watcher = typeof req.query.watcher === 'string' ? req.query.watcher : undefined;
    if (!watcher) {
      res.status(400).json({ error: 'watcher is required' });
      return;
    }
    // Ownership check: a watch may only be cancelled by its own watcher. A foreign watch
    // and a missing one get the SAME 404 — confirming an id exists that isn't yours is
    // exactly the leak this route must avoid (mirrors assertInProject's foreign-vs-missing
    // indistinguishability in agency-mcp.ts).
    const owned = watchesDb.listByWatcher(db, watcher).some((w) => w.id === req.params.id);
    if (!owned) {
      res.status(404).json({ error: 'watch not found' });
      return;
    }
    const ok = watchesDb.remove(db, req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'watch not found' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
