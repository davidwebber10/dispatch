// SEC-23: a project at its cap of live threads refuses a new one; archived and idle (no process) threads do not count.
import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';
import { maxLiveThreadsPerProject } from '../../src/caps.js';

class AlivePty extends PTYManager {
  alive = new Set<string>();
  private pid = 1;
  override spawn(id: string): number { this.alive.add(id); return this.pid++; }
  override write(): void {}
  override resize(): void {}
  override kill(id: string): void { this.alive.delete(id); }
  override getBuffer(): string { return ''; }
  override isAlive(id: string): boolean { return this.alive.has(id); }
  override killAll(): void {}
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-thread-cap-'));
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('live thread cap', () => {
  let svc: SessionService;
  let pty: AlivePty;
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.DISPATCH_MAX_LIVE_THREADS;
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 'p1', provider: 'claude-code', name: 'one', workingDir: tmpDir });
    sessionsDb.create(db, { id: 'p2', provider: 'claude-code', name: 'two', workingDir: tmpDir });
    pty = new AlivePty();
    svc = new SessionService(db, pty, path.join(tmpDir, 'mcp.json'));
  });
  afterEach(() => { if (prev === undefined) delete process.env.DISPATCH_MAX_LIVE_THREADS; else process.env.DISPATCH_MAX_LIVE_THREADS = prev; });

  it('defaults to 60 live threads per project', () => {
    delete process.env.DISPATCH_MAX_LIVE_THREADS;
    expect(maxLiveThreadsPerProject()).toBe(60);
  });

  it('refuses the thread over the cap with a message that names the setting; another project is unaffected', () => {
    process.env.DISPATCH_MAX_LIVE_THREADS = '2';
    svc.createTerminal('p1', 'claude-code');
    svc.createTerminal('p1', 'claude-code');
    expect(() => svc.createTerminal('p1', 'claude-code')).toThrow(/2 live threads.*limit is 2.*DISPATCH_MAX_LIVE_THREADS/);
    expect(svc.listTerminals('p1')).toHaveLength(2);
    expect(() => svc.createTerminal('p2', 'claude-code')).not.toThrow();
  });

  it('counts only threads with a live process: a stopped thread frees its place', () => {
    process.env.DISPATCH_MAX_LIVE_THREADS = '2';
    const a = svc.createTerminal('p1', 'claude-code');
    svc.createTerminal('p1', 'claude-code');
    pty.alive.delete(a.id);
    expect(svc.liveThreadCount('p1')).toBe(1);
    expect(() => svc.createTerminal('p1', 'claude-code')).not.toThrow();
  });

  it('0 turns the cap off', () => {
    process.env.DISPATCH_MAX_LIVE_THREADS = '0';
    for (let i = 0; i < 5; i++) svc.createTerminal('p1', 'claude-code');
    expect(svc.liveThreadCount('p1')).toBe(5);
  });

  it('a queued agent that cannot start at the cap stays queued, untouched', () => {
    process.env.DISPATCH_MAX_LIVE_THREADS = '1';
    svc.createTerminal('p1', 'claude-code');
    const q = svc.createQueuedTerminal('p1', 'claude-code', 'q', { transport: 'structured' }, 'do the thing');
    expect(() => svc.startQueuedTerminal(q.id)).toThrow(/live threads/);
    expect((svc.getTerminal(q.id) as any).config.queued).toBe(true);
    expect(svc.getTerminal(q.id)!.status).toBe('queued');
  });

  it('a dependent that auto-starts is not held back by the cap', () => {
    process.env.DISPATCH_MAX_LIVE_THREADS = '1';
    svc.createTerminal('p1', 'claude-code');
    const q = svc.createQueuedTerminal('p1', 'claude-code', 'q', { transport: 'structured' }, '');
    expect(() => svc.startQueuedTerminal(q.id)).toThrow(/live threads/);
    expect(svc.startQueuedTerminal(q.id, '', { enforceCap: false })).not.toBeNull();
    expect(svc.liveThreadCount('p1')).toBe(2);
  });
});
