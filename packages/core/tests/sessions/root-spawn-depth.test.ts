import { describe, it, expect, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';
import type { IStructuredManager, StructuredSpawnOpts } from '../../src/structured/manager.js';

class CapturingPty extends PTYManager {
  calls: { id: string; command: string; args: string[] }[] = [];
  private pid = 1;
  override spawn(id: string, command: string, args: string[]): number {
    this.calls.push({ id, command, args });
    return this.pid++;
  }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(): boolean { return false; }
  override killAll(): void {}
}

/** Records spawns; enough IStructuredManager for the create path. */
class FakeStructured extends EventEmitter implements IStructuredManager {
  spawns: { terminalId: string; opts: StructuredSpawnOpts }[] = [];
  setDefaultEnv(): void {}
  spawn(terminalId: string, opts: StructuredSpawnOpts): number { this.spawns.push({ terminalId, opts }); return 42; }
  sendMessage(): void {}
  answerPermission(): boolean { return false; }
  setEscalate(): boolean { return false; }
  interrupt(): boolean { return false; }
  compact(): void {}
  noteDeclaredStatus(): void {}
  getPending(): null { return null; }
  getSessionId(): undefined { return undefined; }
  getEvents(): unknown[] { return []; }
  getEventsTail(): unknown[] { return []; }
  getTurnTexts(): string[] | null { return null; }
  isAlive(): boolean { return false; }
  kill(): void {}
  killAll(): void {}
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-root-depth-'));
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

function makeService() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: tmpDir });
  const pty = new CapturingPty();
  const svc = new SessionService(db, pty, path.join(tmpDir, 'mcp.json'));
  svc.setGrokStructuredManager(new FakeStructured());
  svc.setStructuredManager(new FakeStructured());
  return { svc, db };
}

describe('new root threads store spawnDepth 0', () => {
  it('createTerminal writes 0, and keeps a parent-given depth', () => {
    const { svc } = makeService();
    expect(svc.createTerminal('s1', 'claude-code').config.spawnDepth).toBe(0);
    const child = svc.createTerminal('s1', 'claude-code', undefined, undefined, undefined, undefined, { spawnedBy: 'p', spawnDepth: 2, role: 'agent' });
    expect(child.config.spawnDepth).toBe(2);
  });
  it('createQueuedTerminal and createRunnerTerminal write 0', () => {
    const { svc } = makeService();
    expect(svc.createQueuedTerminal('s1', 'claude-code', 'q', { transport: 'structured' }, 'do it').config.spawnDepth).toBe(0);
    expect(svc.createRunnerTerminal('s1', 'claude-code', 'r', undefined, 'go').config.spawnDepth).toBe(0);
  });
  it('ensureCoordinator writes 0', () => {
    const { svc } = makeService();
    const c = svc.ensureCoordinator('s1');
    expect(c.config.role).toBe('coordinator');
    expect(c.config.spawnDepth).toBe(0);
  });
});
