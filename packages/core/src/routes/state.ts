import fs from 'fs';
import path from 'path';
import os from 'os';
import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';

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
      const lines = content.split('\n').filter(l => l.trim());

      let model = '';
      let messageCount = 0;
      let totalCost = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheRead = 0;
      let totalCacheCreation = 0;

      // Per-model pricing (per million tokens)
      const pricing: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
        'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
        'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
        'claude-haiku-4-5-20251001': { input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 },
      };
      const defaultPricing = pricing['claude-sonnet-4-6'];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const msg = entry.message;
          if (!msg || typeof msg !== 'object') continue;
          if (msg.usage) {
            const u = msg.usage;
            const m = msg.model || '';
            const p = pricing[m] || defaultPricing;
            const input = u.input_tokens || 0;
            const output = u.output_tokens || 0;
            const cacheRead = u.cache_read_input_tokens || 0;
            const cacheCreate = u.cache_creation_input_tokens || 0;

            totalInputTokens += input;
            totalOutputTokens += output;
            totalCacheRead += cacheRead;
            totalCacheCreation += cacheCreate;

            totalCost += (input / 1e6) * p.input
                       + (output / 1e6) * p.output
                       + (cacheRead / 1e6) * p.cacheRead
                       + (cacheCreate / 1e6) * p.cacheCreate;
            messageCount++;
          }
          if (msg.model && msg.model !== '<synthetic>') {
            model = msg.model;
          }
        } catch {}
      }

      // Token count matches Claude CLI: input + output + cache_read
      const displayTokens = totalInputTokens + totalOutputTokens + totalCacheRead;

      res.json({
        found: true,
        model,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadTokens: totalCacheRead,
        cacheCreationTokens: totalCacheCreation,
        totalTokens: displayTokens,
        estimatedCostUSD: Math.round(totalCost * 100) / 100,
        messageCount,
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

  // GET /api/state/tailscale — return Tailscale status
  router.get('/tailscale', async (_req, res) => {
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
