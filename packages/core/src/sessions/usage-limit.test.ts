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
import { UsageLimitService } from '../limits/service.js';
import * as parksDb from '../db/usage-limits.js';

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
  getTurnTexts(): string[] | null { return null; }
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


// Wiring of the usage-limit service into SessionService: manager events park and settle, an owner
// message or a stop drops the park, and the auto-resume itself does not count as an owner message.
describe('usage-limit wiring', () => {
  let lim: UsageLimitService;
  const T0 = Date.UTC(2026, 9, 24, 4, 31);
  const RESET = Date.UTC(2026, 9, 24, 5, 10);
  let clock = T0;
  let notes: string[];
  beforeEach(() => {
    clock = T0; notes = [];
    lim = new UsageLimitService({
      db, now: () => clock, zone: 'America/Indianapolis',
      wake: (id, text) => svc.resumeAfterUsageLimit(id, text),
      markPaused: () => {}, note: (_id, text) => notes.push(text),
    });
    svc.setUsageLimitService(lim);
    seed('t1', { config: { transport: 'structured' } });
    terminalsDb.updateStatus(db, 't1', 'scheduled');
    structured.live.add('t1');
  });
  afterEach(() => lim.stop());

  it("a manager 'usage-limit' parks the thread under its harness name", () => {
    structured.emit('usage-limit', 't1', { kind: 'session', resetsAt: RESET, message: 'm' });
    expect(parksDb.get(db, 't1')).toMatchObject({ provider: 'claude-code', kind: 'session', state: 'parked' });
  });
  it('the wake reaches the thread and keeps the attempt count; the owner message drops the park', () => {
    structured.emit('usage-limit', 't1', { kind: 'session', resetsAt: RESET, message: 'm' });
    clock = RESET + 2 * 60_000; lim.tick();
    expect(structured.sent.map((m) => m.content)).toEqual(['Your usage limit has reset. Continue where you left off.']);
    expect(parksDb.get(db, 't1')).toMatchObject({ state: 'woken', attempts: 1 });
    svc.sendThreadMessage('t1', 'actually, do something else', 'user');
    expect(parksDb.get(db, 't1')).toBeNull();
  });
  it('an owner message while parked drops the park before any wake', () => {
    structured.emit('usage-limit', 't1', { kind: 'session', resetsAt: RESET, message: 'm' });
    svc.sendStructuredMessage('t1', 'continue', 'user');
    clock = RESET + 5 * 60_000; lim.tick();
    expect(structured.sent).toHaveLength(1);
    expect(parksDb.get(db, 't1')).toBeNull();
  });
  it('a finished turn clears a woken park', () => {
    structured.emit('usage-limit', 't1', { kind: 'session', resetsAt: RESET, message: 'm' });
    clock = RESET + 2 * 60_000; lim.tick();
    structured.emit('idle', 't1', { declared: false });
    expect(parksDb.get(db, 't1')).toBeNull();
  });
  it('stopping the thread or typing in a CLI thread drops the park', () => {
    structured.emit('usage-limit', 't1', { kind: 'session', resetsAt: RESET, message: 'm' });
    svc.stopTerminal('t1');
    expect(parksDb.get(db, 't1')).toBeNull();
    seed('t2');
    lim.park('t2', 'claude-code', { kind: 'session', resetsAt: RESET, message: 'm' });
    svc.noteUserInput('t2', 'hello\r');
    expect(parksDb.get(db, 't2')).toBeNull();
  });
  it('a coordinator or daemon send is not the owner taking over; an interrupt is', () => {
    structured.emit('usage-limit', 't1', { kind: 'session', resetsAt: RESET, message: 'm' });
    svc.sendStructuredMessage('t1', 'status ping', 'coordinator');
    expect(parksDb.get(db, 't1')).not.toBeNull();
    svc.sendStructuredMessage('t1', 'daemon note', undefined, 'daemon');
    expect(parksDb.get(db, 't1')).not.toBeNull();
    svc.interrupt('t1');
    expect(parksDb.get(db, 't1')).toBeNull();
  });
  it("a failed turn ends a woken chain", () => {
    structured.emit('usage-limit', 't1', { kind: 'session', resetsAt: RESET, message: 'm' });
    clock = RESET + 2 * 60_000; lim.tick();
    structured.emit('failed', 't1');
    expect(parksDb.get(db, 't1')).toBeNull();
  });
});
