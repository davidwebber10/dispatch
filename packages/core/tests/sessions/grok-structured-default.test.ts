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
  isAlive(): boolean { return false; }
  kill(): void {}
  killAll(): void {}
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-grok-structured-'));
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

function makeService(withGrokManager: boolean) {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: tmpDir });
  const pty = new CapturingPty();
  const svc = new SessionService(db, pty, path.join(tmpDir, 'mcp.json'));
  const grok = new FakeStructured();
  if (withGrokManager) svc.setGrokStructuredManager(grok);
  return { svc, pty, grok };
}

/**
 * Grok is structured-only for NEW threads: the PTY/TUI never rendered well in Dispatch, so
 * a creation request that names no transport gets Pretty — from every client, not just a
 * modal new enough to send it.
 */
describe('grok threads default to the structured transport at creation', () => {
  it('a new grok thread with no transport goes structured, not PTY', () => {
    const { svc, pty, grok } = makeService(true);
    const t = svc.createTerminal('s1', 'grok', 'Grok');
    expect(t.config?.transport).toBe('structured');
    expect(grok.spawns.map((s) => s.terminalId)).toContain(t.id);
    expect(pty.calls.find((c) => c.id === t.id)).toBeUndefined();
  });

  it('an explicit transport in the request still wins', () => {
    const { svc, pty, grok } = makeService(true);
    const t = svc.createTerminal('s1', 'grok', 'Grok', undefined, undefined, undefined, { transport: 'pty' });
    expect(t.config?.transport).toBe('pty');
    expect(grok.spawns).toHaveLength(0);
    expect(pty.calls.find((c) => c.id === t.id)).toBeDefined();
  });

  it('falls back to PTY when the structured manager is absent (kill-switch)', () => {
    const { svc, pty } = makeService(false);
    const t = svc.createTerminal('s1', 'grok', 'Grok');
    expect(t.config?.transport).toBeUndefined();
    expect(pty.calls.find((c) => c.id === t.id)).toBeDefined();
  });

  it('claude threads are untouched by the grok default', () => {
    const { svc, pty } = makeService(true);
    const t = svc.createTerminal('s1', 'claude-code', 'CC');
    expect(t.config?.transport).toBeUndefined();
    expect(pty.calls.find((c) => c.id === t.id)).toBeDefined();
  });
});
