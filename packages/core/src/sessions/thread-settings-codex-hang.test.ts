// A Codex app-server that is alive but never answers must not hold a thread's settings lock (round 3, item 2).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { SessionService } from './service.js';
import { CodexStructuredSessionManager } from '../structured/codex-manager.js';

class FakePty extends EventEmitter { isAlive() { return false; } kill() {} spawn() { return 1; } setDefaultEnv() {} }
const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'structured', 'fake-codex-app-server.mjs');

let dir: string; let db: Database.Database; let svc: SessionService; let codex: CodexStructuredSessionManager; let origHome: string | undefined;
beforeEach(() => {
  origHome = process.env.HOME;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-codex-hang-'));
  fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
  process.env.HOME = dir;
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: path.join(dir, 'proj') });
  svc = new SessionService(db, new FakePty() as any, path.join(dir, 'mcp.json'));
  codex = new CodexStructuredSessionManager({ modelListTimeoutMs: 150 });
  svc.setCodexStructuredManager(codex);
});
afterEach(() => {
  codex.killAll();
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a hung Codex app-server', () => {
  it('does not hold the settings lock: the change is judged against the built-in table, and the next one is not stuck behind it', async () => {
    terminalsDb.create(db, { id: 'x1', sessionId: 's1', type: 'codex', label: 'x1', workingDir: path.join(dir, 'proj'), externalId: 'e', config: { transport: 'structured', model: 'gpt-6-luna' } });
    codex.spawn('x1', { command: process.execPath, args: [fake], workDir: process.cwd(), env: { CODEX_FAKE_INIT_HANG: '1' } });
    const first = await Promise.race([
      svc.setThreadSettings('x1', { effort: 'max' }),
      new Promise<'stuck'>((r) => setTimeout(() => r('stuck'), 3000)),
    ]);
    expect(first).not.toBe('stuck');
    await expect(svc.setThreadSettings('x1', { effort: 'ultra' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/gpt-6-luna does not take that effort/) }); // table: Luna has no ultra
    const cfg = JSON.parse(terminalsDb.getById(db, 'x1')!.config ?? '{}');
    expect(cfg.effort).toBe('max');
  });
});
