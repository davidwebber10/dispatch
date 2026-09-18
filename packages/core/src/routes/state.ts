import fs from 'fs';
import path from 'path';
import os from 'os';
import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import { platform } from '../platform/index.js';
import { summary } from '../analytics/queries.js';
import { getRunningVersion, isNewerVersion } from '../update/version.js';
import { parseStoredNotes, readLocalReleaseNote } from '../update/notes.js';
import { revealClientFrom } from '../files/reveal.js';

export function createStateRouter(db: Database.Database): Router {
  const router = Router();

  // GET /api/state/last-directory — return last used working directory
  router.get('/last-directory', (_req, res) => {
    const directory = appState.get(db, 'last_directory');
    res.json({ directory });
  });

  // GET /api/state/active-session — return persisted active session ID
  router.get('/active-session', (_req, res) => {
    const sessionId = appState.get(db, 'active_session');
    res.json({ sessionId });
  });

  // POST /api/state/active-session — save the active session ID
  router.post('/active-session', (req, res) => {
    const { sessionId } = req.body;
    if (sessionId) {
      appState.set(db, 'active_session', sessionId);
    }
    res.json({ ok: true });
  });

  // GET /api/state/browse?path=~ — list any directory on the server (for project creation)
  router.get('/browse', (req, res) => {
    try {
      let dirPath = (req.query.path as string) || '~';
      dirPath = dirPath.replace(/^~/, os.homedir());
      dirPath = path.resolve(dirPath);

      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        return res.status(400).json({ error: 'Not a directory' });
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          path: path.join(dirPath, e.name),
        }));

      res.json(entries);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/state/mkdir?path=~/foo — create a directory anywhere (for project creation)
  router.post('/mkdir', (req, res) => {
    try {
      let dirPath = (req.query.path as string) || '';
      if (!dirPath) return res.status(400).json({ error: 'path required' });
      dirPath = dirPath.replace(/^~/, os.homedir());
      dirPath = path.resolve(dirPath);
      fs.mkdirSync(dirPath, { recursive: true });
      res.json({ ok: true, path: dirPath });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Thread statistics share the analytics ledger across all harnesses.
  router.get('/session-stats/:sessionId', (req, res) => {
    const terminal = db.prepare('SELECT id FROM terminals WHERE id=? OR external_id=? LIMIT 1')
      .get(req.params.sessionId, req.params.sessionId) as { id: string } | undefined;
    if (!terminal) return res.json({ found: false });
    const stats = summary(db, { terminalId: terminal.id });
    if (!stats.turns) return res.json({ found: false });
    const models = db.prepare(`SELECT DISTINCT model FROM usage_measurements WHERE terminal_id=? AND ended_at IS NOT NULL AND model != ''`).all(terminal.id) as { model: string }[];
    return res.json({ found: true, model: models.length === 1 ? models[0].model : 'multiple',
      inputTokens: stats.inputTokens, outputTokens: stats.outputTokens, cacheReadTokens: stats.cacheReadTokens,
      cacheCreationTokens: stats.cacheCreateTokens, totalTokens: stats.totalTokens,
      estimatedCostUSD: stats.valueIsPartial && stats.apiValueUsd === 0 ? null : stats.apiValueUsd,
      reportedCostUSD: stats.reportedCostUsd, coverage: stats.coverage, valueIsPartial: stats.valueIsPartial,
      messageCount: (db.prepare('SELECT COALESCE(SUM(messages),0) AS n FROM usage_turns WHERE terminal_id=? AND ended_at IS NOT NULL').get(terminal.id) as { n: number }).n,
    });
  });

  // GET /api/state/terminal-status/:terminalId — return live terminal activity/status
  router.get('/terminal-status/:terminalId', (req, res) => {
    // This will be populated by the server's terminalMonitor
    // For now return empty — the real data comes via WebSocket events
    res.json({ activity: 'unknown' });
  });

  // GET /api/state/update — latest known GitHub release, re-checked against the
  // running version on every read (not a trusted stored flag) so a late-joining
  // client — or one that reconnects after `dispatch update` already ran — never
  // sees a stale "update available" banner for a release it's already running.
  //
  // `notes` carries the human-readable release notes for every version between the one
  // running here and the newest one, so the update prompt can show what the update
  // contains before it installs. `currentNotes` is the note for the version running
  // right now, read from this checkout — that one CAN come from disk, because the file
  // shipped with the code.
  router.get('/update', (_req, res) => {
    const tag = appState.get(db, 'latest_release_tag');
    const url = appState.get(db, 'latest_release_url');
    const publishedAt = appState.get(db, 'latest_release_published_at');
    const currentVersion = getRunningVersion();
    const available = !!tag && isNewerVersion(tag, currentVersion);
    res.json({
      available,
      version: available ? tag : null,
      url: available ? url : null,
      publishedAt: available ? publishedAt : null,
      currentVersion,
      notes: available ? parseStoredNotes(appState.get(db, 'latest_release_notes'), currentVersion) : [],
      currentNotes: readLocalReleaseNote(currentVersion),
    });
  });

  // GET /api/state/tailscale — return Tailscale status
  router.get('/tailscale', async (_req, res) => {
    res.json(await platform.tailscaleStatus());
  });

  // GET /api/state/status-quality — how often agents declare their end state (report_status)
  // versus how often the turn-end heuristic had to guess. `config.lastOutcome.inferred` means
  // exactly "the agent did NOT declare" (set in sessions/service.ts#noteTurnOutcome) — it is
  // orthogonal to `needsHelp`, which is which end state it was. So `declared`/`inferred` here
  // IS the declaration-compliance rate, and `needsHelp*` is the heuristic's exposure specifically
  // on the needs-help path (its false-positive surface), a different question. Phase 2 (the
  // board) leans on needs-help being trustworthy; this is how we find out before building on it.
  // Reads every terminal's config rather than pre-filtering with SQL `LIKE` (which would also
  // match a config that merely mentions the string "lastOutcome" in unrelated text) — a row only
  // counts when `lastOutcome` parses out as a genuine object. Malformed config JSON is skipped,
  // never thrown. Terminals that never ran a turn (no `lastOutcome` at all) count in neither
  // bucket — they aren't evidence about compliance.
  router.get('/status-quality', (_req, res) => {
    const rows = db.prepare('SELECT config FROM terminals').all() as { config: string | null }[];
    let declared = 0, inferred = 0, needsHelpDeclared = 0, needsHelpInferred = 0;
    for (const r of rows) {
      if (!r.config) continue;
      let cfg: any;
      try { cfg = JSON.parse(r.config); } catch { continue; }
      const outcome = cfg?.lastOutcome;
      if (!outcome || typeof outcome !== 'object') continue;
      if (outcome.inferred) {
        inferred++;
        if (outcome.needsHelp) needsHelpInferred++;
      } else {
        declared++;
        if (outcome.needsHelp) needsHelpDeclared++;
      }
    }
    res.json({ declared, inferred, total: declared + inferred, needsHelpDeclared, needsHelpInferred });
  });

  // GET /api/state/host — what can this daemon do for the browser asking?
  // `canReveal` is true only when this platform has a native file manager AND the browser is
  // genuinely on this machine: a loopback SOCKET address (never req.ip), a loopback Host header,
  // and no proxy headers — a same-host reverse proxy (cloudflared, `tailscale serve`) makes every
  // remote visitor look like a loopback peer, so the socket alone proves nothing. Both facts come
  // from the platform module (see platform/types.ts, files/reveal.ts for the loopback helpers).
  // Purely a UI affordance: POST /files/reveal enforces it again.
  router.get('/host', (req, res) => {
    const client = revealClientFrom(req);
    res.json({
      // Sanctioned exception to the no-`process.platform`-reads rule: this reports a fact about
      // the daemon's OS to the client, it does not branch behavior.
      platform: process.platform,
      flavor: platform.flavor,
      fileManagerName: platform.fileManagerName,
      canReveal: platform.fileManagerName !== null && platform.isLocalClient(client),
    });
  });

  return router;
}
