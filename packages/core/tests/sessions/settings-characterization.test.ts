// W3-B characterization: the thread settings of SessionService, recorded through the facade before
// the code moved to ThreadSettings. The facade must answer the same after the move.
import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';

class FakePty extends EventEmitter {
  alive = new Set<string>();
  isAlive(id: string) { return this.alive.has(id); }
  kill(id: string) { this.alive.delete(id); this.emit('exit', id, 0); }
  spawn(id: string) { this.alive.add(id); return 4321; }
  write() {}
  setDefaultEnv() {}
}

class FakeStructured extends EventEmitter {
  live = new Set<string>();
  escalate: [string, boolean][] = [];
  efforts: [string, string][] = [];
  models: [string, string][] = [];
  setDefaultEnv() {}
  spawn(id: string) { this.live.add(id); return 1; }
  sendMessage() {}
  answerPermission() { return false; }
  setEscalate(id: string, on: boolean) { this.escalate.push([id, on]); return true; }
  interrupt() { return true; }
  compact() {}
  noteDeclaredStatus() {}
  getPending() { return null; }
  getSessionId() { return undefined; }
  getEvents() { return []; }
  getEventsTail() { return []; }
  getTurnTexts(): string[] | null { return null; }
  getModel() { return undefined; }
  async setModel(id: string, model: string) { this.models.push([id, model]); return model; }
  async setEffort(id: string, effort: string) { this.efforts.push([id, effort]); }
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.live.delete(id); this.emit('exit', id, 0); }
  killAll() { this.live.clear(); }
}

let db: Database.Database;
let pty: FakePty;
let mgr: FakeStructured;
let svc: SessionService;
const cfg = (id: string) => JSON.parse(terminalsDb.getById(db, id)!.config || '{}');
const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return { status: (e as { status?: number }).status, message: (e as Error).message }; } };

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  pty = new FakePty();
  mgr = new FakeStructured();
  svc = new SessionService(db, pty as any, '/tmp/dispatch-settings-char-mcp.json');
  svc.registerStructuredManager('claude-code', mgr as any);
  terminalsDb.create(db, { id: 't', sessionId: 's1', type: 'claude-code', label: 't', config: { transport: 'structured', keep: 'me', wakeAt: 123 } });
});

describe('SessionService thread settings (characterization)', () => {
  it('a model switch on a busy thread is refused with 409 and the busy text; nothing is saved', async () => {
    terminalsDb.updateStatus(db, 't', 'working');
    expect(await refusal(svc.setThreadModel('t', 'opus'))).toEqual({ status: 409, message: 'This thread is busy — change the model when the turn ends' });
    terminalsDb.updateStatus(db, 't', 'needs_input');
    expect((await refusal(svc.setThreadEffort('t', 'high')))?.status).toBe(409);
    expect((await refusal(svc.setThreadEffort('t', 'high')))?.message).toContain('waiting for your answer');
    expect(cfg('t')).toEqual({ transport: 'structured', keep: 'me', wakeAt: 123 });
  });

  it('a model or effort change is refused for a missing thread (404), a shell tab and an agent thread (409)', async () => {
    terminalsDb.create(db, { id: 'sh', sessionId: 's1', type: 'shell', label: 'sh' });
    terminalsDb.create(db, { id: 'ag', sessionId: 's1', type: 'claude-code', label: 'ag', config: { role: 'agent' } });
    expect(await refusal(svc.setThreadModel('missing', 'opus'))).toEqual({ status: 404, message: 'Terminal not found' });
    expect(await refusal(svc.setThreadModel('sh', 'opus'))).toEqual({ status: 409, message: 'This thread has no model to switch' });
    expect(await refusal(svc.setThreadEffort('ag', 'high'))).toEqual({ status: 409, message: 'An agent thread runs on its policy model' });
    expect(await refusal(svc.setThreadModel('t', 'not a model!'))).toEqual({ status: 400, message: 'model is not a valid model id' });
  });

  it('an effort change saves the effort and its time, and keeps every other key', async () => {
    const out = await svc.setThreadEffort('t', 'high');
    expect(out.effort).toBe('high');
    const c = cfg('t');
    expect(typeof c.effortSetAt).toBe('number');
    delete c.effortSetAt;
    expect(c).toEqual({ transport: 'structured', keep: 'me', wakeAt: 123, effort: 'high' });
    expect(mgr.efforts).toEqual([]); // no live process: the pick is applied at the next start
  });

  it('a model change on a live Pretty thread is sent to the process and saved', async () => {
    mgr.live.add('t');
    const out = await svc.setThreadModel('t', 'sonnet');
    expect(out.model).toBe('sonnet');
    expect(mgr.models).toEqual([['t', 'sonnet']]);
    expect(cfg('t').model).toBe('sonnet');
    expect(cfg('t').keep).toBe('me');
    expect(svc.activeModel('t')).toBe('sonnet');
  });

  it('autonomy is one key, and the manager is told to escalate or not', () => {
    expect(svc.setAutonomy('missing', 'autonomous')).toBe(false);
    expect(svc.setAutonomy('t', 'autonomous')).toBe(true);
    expect(svc.setAutonomy('t', 'supervised')).toBe(true);
    expect(mgr.escalate).toEqual([['t', false], ['t', true]]);
    expect(cfg('t')).toEqual({ transport: 'structured', keep: 'me', wakeAt: 123, autonomy: 'supervised' });
  });

  it('a transport switch is refused for a missing thread, a type without two transports, a thread with no session, and a coordinator to CLI', async () => {
    terminalsDb.create(db, { id: 'gk', sessionId: 's1', type: 'grok', label: 'gk' });
    terminalsDb.create(db, { id: 'co', sessionId: 's1', type: 'claude-code', label: 'co', externalId: 'x', config: { transport: 'structured', role: 'coordinator' } });
    terminalsDb.create(db, { id: 'cx', sessionId: 's1', type: 'codex', label: 'cx', externalId: 'x' });
    expect(await refusal(svc.switchTransport('missing', 'pty'))).toEqual({ status: 404, message: 'Terminal not found' });
    expect(await refusal(svc.switchTransport('gk', 'pty'))).toEqual({ status: 409, message: 'Transport switching is only supported for Claude Code and Codex threads' });
    expect(await refusal(svc.switchTransport('t', 'pty'))).toEqual({ status: 409, message: 'This thread has no session yet — send a message first, then switch' });
    expect(await refusal(svc.switchTransport('co', 'pty'))).toEqual({ status: 409, message: 'A coordinator must stay on Pretty transport — it cannot run as a PTY thread' });
    expect(await refusal(svc.switchTransport('cx', 'structured'))).toEqual({ status: 409, message: 'Pretty transport is not available for this harness yet' });
  });

  it('a transport switch to the transport the thread has changes nothing; a busy thread with no live process is refused unless forced', async () => {
    terminalsDb.create(db, { id: 'p', sessionId: 's1', type: 'claude-code', label: 'p', externalId: 'sess', config: { keep: 1 } });
    const same = await svc.switchTransport('p', 'pty');
    expect(same.id).toBe('p');
    expect(cfg('p')).toEqual({ keep: 1 });
    terminalsDb.updateStatus(db, 'p', 'working');
    expect(await refusal(svc.switchTransport('p', 'structured'))).toEqual({ status: 409, message: 'This thread is busy — wait for the current turn to finish, then switch' });
  });

  it('an account switch is refused for a missing thread, a type with no account, and an empty account id', async () => {
    terminalsDb.create(db, { id: 'gk', sessionId: 's1', type: 'grok', label: 'gk' });
    expect(await refusal(svc.switchAccount('missing', 'a'))).toEqual({ status: 404, message: 'Terminal not found' });
    expect(await refusal(svc.switchAccount('gk', 'a'))).toEqual({ status: 409, message: 'Only a Claude Code or Codex thread runs on an account' });
    expect(await refusal(svc.switchAccount('t', ''))).toEqual({ status: 400, message: 'accountId is required' });
    svc.setAccountDirectory({ has: () => false, defaultId: () => 'cli' });
    expect(await refusal(svc.switchAccount('t', 'nope'))).toEqual({ status: 404, message: 'Unknown account' });
  });

  it('an account switch on a thread with no live process saves the account id only', async () => {
    const out = await svc.switchAccount('t', 'work');
    expect((out.config as Record<string, unknown>).accountId).toBe('work');
    expect(cfg('t')).toEqual({ transport: 'structured', keep: 'me', wakeAt: 123, accountId: 'work' });
    expect(mgr.live.has('t')).toBe(false);
  });

  it('auto-archive and alerts are patches of their own keys; a missing thread answers null', () => {
    expect(svc.setAutoArchive('missing', true)).toBeNull();
    expect(svc.setAlertsEnabled('missing', true)).toBeNull();
    svc.setAlertsEnabled('t', true);
    expect(cfg('t').alertsEnabled).toBe(true);
    svc.setAlertsEnabled('t', false);
    expect('alertsEnabled' in cfg('t')).toBe(false);
    svc.setAutoArchive('t', true, 60_000);
    const on = cfg('t');
    expect(on.keep).toBe('me');
    svc.setAutoArchive('t', false);
    expect(Object.keys(cfg('t')).sort()).not.toEqual(Object.keys(on).sort());
    expect(cfg('t').wakeAt).toBe(123);
  });
});
