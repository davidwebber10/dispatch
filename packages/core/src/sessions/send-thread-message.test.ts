import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { SessionService } from './service.js';
import type { IStructuredManager } from '../structured/manager.js';

// Harness mirrors switch-transport.test.ts: a real sqlite db with stub managers, so the
// transport DISPATCH in sendThreadMessage is exercised for real without spawning a process.

class FakePty extends EventEmitter {
  alive = new Set<string>();
  writes: { id: string; data: string }[] = [];
  isAlive(id: string) { return this.alive.has(id); }
  write(id: string, data: string) { this.writes.push({ id, data }); }
  kill(id: string) { this.alive.delete(id); }
  spawn(id: string) { this.alive.add(id); return 1234; }
  setDefaultEnv() {}
}

class FakeStructured extends EventEmitter implements IStructuredManager {
  live = new Set<string>();
  sent: { id: string; content: unknown; source?: string }[] = [];
  setDefaultEnv() {}
  spawn(id: string) { this.live.add(id); return 4321; }
  sendMessage(id: string, content: unknown, source?: any) { this.sent.push({ id, content, source }); }
  answerPermission() { return false; }
  setEscalate() { return false; }
  interrupt() { return true; }
  compact() {}
  noteDeclaredStatus() {}
  getPending() { return null; }
  getSessionId() { return undefined; }
  getEvents() { return []; }
  getEventsTail() { return []; }
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.live.delete(id); }
  killAll() { this.live.clear(); }
}

let dir: string;
let db: Database.Database;
let svc: SessionService;
let pty: FakePty;
let structured: FakeStructured;

function seed(id: string, opts: { type?: string; config?: Record<string, any> } = {}) {
  terminalsDb.create(db, {
    id,
    sessionId: 's1',
    type: opts.type ?? 'claude-code',
    label: id,
    workingDir: path.join(dir, 'proj'),
    externalId: 'ext-1',
    config: opts.config ?? {},
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-msg-'));
  fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: path.join(dir, 'proj') });
  pty = new FakePty();
  structured = new FakeStructured();
  svc = new SessionService(db, pty as any, path.join(dir, 'mcp.json'));
  svc.setStructuredManager(structured);
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('sendThreadMessage — transport dispatch', () => {
  it('delivers to a PTY thread by typing into its terminal (the bug: this used to throw)', () => {
    seed('t1', { config: {} });            // no transport → PTY
    pty.alive.add('t1');

    const out = svc.sendThreadMessage('t1', 'ping from a peer', 'coordinator');

    expect(out).toEqual({ transport: 'pty', droppedNonText: false });
    expect(pty.writes).toEqual([{ id: 't1', data: 'ping from a peer\r' }]);
    expect(structured.sent).toHaveLength(0); // never went near the structured channel
  });

  it('multi-line text reaches a PTY thread as ONE submitted message (bracketed paste)', () => {
    seed('t1', { config: {} });
    pty.alive.add('t1');

    svc.sendThreadMessage('t1', 'first line\nsecond line');

    const data = pty.writes[0].data;
    expect(data).toBe('\x1b[200~first line\nsecond line\x1b[201~\r');
    // One submit only — otherwise the peer would receive two half-messages.
    expect(data.split('\r')).toHaveLength(2);
  });

  it('still delivers a structured thread over its own channel, untouched', () => {
    seed('t1', { config: { transport: 'structured' } });
    structured.live.add('t1');

    const out = svc.sendThreadMessage('t1', 'hello', 'coordinator');

    expect(out).toEqual({ transport: 'structured', droppedNonText: false });
    expect(structured.sent).toEqual([{ id: 't1', content: 'hello', source: 'coordinator' }]);
    expect(pty.writes).toHaveLength(0); // never typed into a terminal
  });

  it('treats a structured-flagged thread whose harness has no structured manager as PTY', () => {
    // A codex row can carry transport:'structured' while Codex-Pretty is disabled — it is
    // really a PTY, and messaging it must not fall into the structured branch and throw.
    seed('t1', { type: 'codex', config: { transport: 'structured' } });
    pty.alive.add('t1');

    expect(svc.sendThreadMessage('t1', 'hi').transport).toBe('pty');
    expect(pty.writes[0].data).toBe('hi\r');
  });

  it('fails clearly when the PTY thread is not running (never silently drops the message)', () => {
    seed('t1', { config: {} }); // not alive
    expect(() => svc.sendThreadMessage('t1', 'hi')).toThrow(/not running/i);
    expect(pty.writes).toHaveLength(0);
  });

  it('reports dropped image blocks rather than delivering a partial message', () => {
    seed('t1', { config: {} });
    pty.alive.add('t1');

    const out = svc.sendThreadMessage('t1', [
      { type: 'text', text: 'see this' },
      { type: 'image', source: { data: 'x' } },
    ] as any);

    expect(out).toEqual({ transport: 'pty', droppedNonText: true });
    expect(pty.writes[0].data).toBe('see this\r');
  });

  it('refuses an image-only payload to a PTY thread with an explanatory error', () => {
    seed('t1', { config: {} });
    pty.alive.add('t1');
    expect(() => svc.sendThreadMessage('t1', [{ type: 'image' }] as any)).toThrow(/images can only be sent to a Pretty thread/i);
    expect(pty.writes).toHaveLength(0);
  });

  it('throws for an unknown thread', () => {
    expect(() => svc.sendThreadMessage('nope', 'hi')).toThrow(/not found/i);
  });
});
