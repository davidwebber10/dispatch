import fs from 'fs';
import path from 'path';
import os from 'os';
import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import { platform } from '../platform/index.js';
import { sumTranscriptTokens } from '../sessions/cc-sessions.js';
import { getRunningVersion, isNewerVersion } from '../update/version.js';

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

  // GET /api/state/session-stats/:sessionId — return Claude session usage stats
  router.get('/session-stats/:sessionId', (req, res) => {
    try {
      const sessionId = req.params.sessionId;
      const homeDir = os.homedir();
      const projectDirs = fs.readdirSync(path.join(homeDir, '.claude', 'projects'));

      let jsonlPath: string | null = null;
      // Search for the session JSONL file across all project dirs
      for (const dir of projectDirs) {
        const candidate = path.join(homeDir, '.claude', 'projects', dir, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          jsonlPath = candidate;
          break;
        }
      }

      if (!jsonlPath) {
        return res.json({ found: false });
      }

      const content = fs.readFileSync(jsonlPath, 'utf-8');
      const stats = sumTranscriptTokens(content);

      // Per-model pricing (per million tokens)
      const pricing: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
        'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
        'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
        'claude-haiku-4-5-20251001': { input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 },
      };
      const p = pricing[stats.model] || pricing['claude-sonnet-4-6'];
      const totalCost = (stats.inputTokens / 1e6) * p.input
                       + (stats.outputTokens / 1e6) * p.output
                       + (stats.cacheReadTokens / 1e6) * p.cacheRead
                       + (stats.cacheCreationTokens / 1e6) * p.cacheCreate;

      res.json({
        found: true,
        model: stats.model,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cacheReadTokens: stats.cacheReadTokens,
        cacheCreationTokens: stats.cacheCreationTokens,
        totalTokens: stats.totalTokens,
        estimatedCostUSD: Math.round(totalCost * 100) / 100,
        messageCount: stats.messageCount,
      });
    } catch (err: any) {
      res.json({ found: false, error: err.message });
    }
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
    });
  });

  // GET /api/state/tailscale — return Tailscale status
  router.get('/tailscale', async (_req, res) => {
    if (platform.id !== 'darwin') {
      return res.json({ ip: null, hostname: null, online: false });
    }
    try {
      const { execSync } = await import('child_process');
      const output = execSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const status = JSON.parse(output);
      const self = status.Self || {};
      res.json({
        ip: (self.TailscaleIPs || [])[0] || null,
        hostname: self.HostName || null,
        online: self.Online || false,
      });
    } catch {
      res.json({ ip: null, hostname: null, online: false });
    }
  });

  return router;
}
