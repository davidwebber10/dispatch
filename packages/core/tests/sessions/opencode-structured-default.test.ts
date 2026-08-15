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
import { OPENCODE_DEFAULT_MODEL } from '../../src/providers/opencode.js';
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-opencode-structured-'));
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

function makeService(withManager: boolean) {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: tmpDir });
  const pty = new CapturingPty();
  const svc = new SessionService(db, pty, path.join(tmpDir, 'mcp.json'));
  const mgr = new FakeStructured();
  if (withManager) svc.setOpencodeStructuredManager(mgr);
  return { svc, pty, mgr };
}

/**
 * OpenCode is Pretty-ONLY — stricter than Grok's default. There is no PTY provider at all
 * (providers/opencode.ts throws), so every creation path gets transport 'structured'
 * stamped UNCONDITIONALLY, and the curated default model is pinned when none is picked.
 */
describe('opencode threads are structured-only at creation', () => {
  it('a new opencode thread goes structured with the default model pinned', () => {
    const { svc, pty, mgr } = makeService(true);
    const t = svc.createTerminal('s1', 'opencode', 'OpenCode');
    expect(t.config?.transport).toBe('structured');
    const spawn = mgr.spawns.find((s) => s.terminalId === t.id);
    expect(spawn).toBeDefined();
    expect(spawn!.opts.model).toBe(OPENCODE_DEFAULT_MODEL);
    expect(spawn!.opts.command).toBe('opencode');
    expect(spawn!.opts.args).toEqual(['acp']);
    expect(pty.calls.find((c) => c.id === t.id)).toBeUndefined();
  });

  it('a picked model wins over the default', () => {
    const { svc, mgr } = makeService(true);
    const t = svc.createTerminal('s1', 'opencode', 'OC', undefined, undefined, undefined, { model: 'openrouter/moonshotai/kimi-k3' });
    expect(mgr.spawns.find((s) => s.terminalId === t.id)!.opts.model).toBe('openrouter/moonshotai/kimi-k3');
  });

  it('even an explicit transport:"pty" is overridden — Pretty-only means Pretty-only', () => {
    const { svc, pty, mgr } = makeService(true);
    const t = svc.createTerminal('s1', 'opencode', 'OC', undefined, undefined, undefined, { transport: 'pty' });
    expect(t.config?.transport).toBe('structured');
    expect(mgr.spawns.map((s) => s.terminalId)).toContain(t.id);
    expect(pty.calls.find((c) => c.id === t.id)).toBeUndefined();
  });

  it('with the manager absent (kill-switch) creation fails LOUDLY — never falls back to PTY', () => {
    const { svc, pty } = makeService(false);
    // The provider's PTY builders throw on purpose; createTerminal surfaces that and
    // removes the row. A silent PTY fallback would spawn a TUI Dispatch can't drive.
    expect(() => svc.createTerminal('s1', 'opencode', 'OC')).toThrow(/Pretty-only/);
    expect(pty.calls).toHaveLength(0);
  });
});
