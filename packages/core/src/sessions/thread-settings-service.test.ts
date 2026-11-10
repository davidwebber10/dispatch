// ThreadSettings alone: built from its typed inputs, with no SessionService.
import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { ThreadConfigStore } from './thread-config.js';
import { ThreadSettings, transportError } from './thread-settings-service.js';

class FakePty extends EventEmitter {
  alive = new Set<string>();
  isAlive(id: string) { return this.alive.has(id); }
  kill(id: string) { this.alive.delete(id); this.emit('exit', id, 0); }
}

class FakeManager extends EventEmitter {
  live = new Set<string>();
  efforts: [string, string][] = [];
  models: [string, string][] = [];
  notices: string[] = [];
  refuseNext: Error | null = null;
  isAlive(id: string) { return this.live.has(id); }
  kill(id: string) { this.live.delete(id); this.emit('exit', id, 0); }
  getModel() { return undefined; }
  setEscalate() { return true; }
  interrupt() { return true; }
  postNotice(_id: string, m: string) { this.notices.push(m); }
  async setModel(id: string, model: string) { if (this.refuseNext) { const e = this.refuseNext; this.refuseNext = null; throw e; } this.models.push([id, model]); return model; }
  async setEffort(id: string, effort: string) { if (this.refuseNext) { const e = this.refuseNext; this.refuseNext = null; throw e; } this.efforts.push([id, effort]); }
}

let db: Database.Database;
let pty: FakePty;
let mgr: FakeManager;
let settings: ThreadSettings;
let spawned: string[];
let revoked: string[];
let changed: string[];
const cfg = (id: string) => JSON.parse(terminalsDb.getById(db, id)!.config || '{}');
const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return { status: (e as { status?: number }).status, message: (e as Error).message }; } };

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  terminalsDb.create(db, { id: 't', sessionId: 's1', type: 'claude-code', label: 't', externalId: 'sess', config: { transport: 'structured', keep: 'me', wakeAt: 123 } });
  pty = new FakePty();
  mgr = new FakeManager();
  spawned = []; revoked = []; changed = [];
  settings = new ThreadSettings({
    db,
    configStore: new ThreadConfigStore(db),
    pty: pty as any,
    accountDirectory: () => undefined,
    onTerminalChanged: (sessionId) => { changed.push(sessionId); },
    threads: {
      structuredManagerFor: (type) => (type === 'claude-code' ? (mgr as any) : undefined),
      structuredManagerForTerminal: (id) => (terminalsDb.getById(db, id)?.type === 'claude-code' ? (mgr as any) : undefined),
      isStructuredTerminal: (row) => JSON.parse(row.config || '{}').transport === 'structured',
      spawnTerminal: (id) => { spawned.push(id); },
      revokeAllKeys: (id) => { revoked.push(id); },
    },
  });
});

describe('ThreadSettings', () => {
  it('a model switch on a busy thread is refused with the same error as before', async () => {
    terminalsDb.updateStatus(db, 't', 'working');
    expect(await refusal(settings.setThreadModel('t', 'opus'))).toEqual({ status: 409, message: 'This thread is busy — change the model when the turn ends' });
    expect(mgr.models).toEqual([]);
    expect(cfg('t')).toEqual({ transport: 'structured', keep: 'me', wakeAt: 123 });
  });

  it('an effort change patches only the effort key', async () => {
    mgr.live.add('t');
    await settings.setThreadEffort('t', 'high');
    expect(mgr.efforts).toEqual([['t', 'high']]);
    const c = cfg('t');
    expect(typeof c.effortSetAt).toBe('number');
    delete c.effortSetAt;
    expect(c).toEqual({ transport: 'structured', keep: 'me', wakeAt: 123, effort: 'high' });
  });

  it('an effort that the live harness refuses is not saved; the thread shows the reason and the caller gets 400', async () => {
    mgr.live.add('t');
    mgr.refuseNext = new Error('effort not supported');
    expect(await refusal(settings.setThreadEffort('t', 'high'))).toEqual({ status: 400, message: 'effort not supported' });
    expect(mgr.notices).toEqual(['Could not change the effort: effort not supported']);
    expect('effort' in cfg('t')).toBe(false);
  });

  it('two changes of one thread run one after the other', async () => {
    mgr.live.add('t');
    const order: string[] = [];
    const a = settings.setThreadModel('t', 'opus').then(() => order.push('model'));
    const b = settings.setThreadEffort('t', 'low').then(() => order.push('effort'));
    await Promise.all([a, b]);
    expect(order).toEqual(['model', 'effort']);
    expect(cfg('t').model).toBe('opus');
    expect(cfg('t').effort).toBe('low');
  });

  it('a transport switch stops the process, revokes the keys, patches the one key and starts the thread again, in that order', async () => {
    mgr.live.add('t');
    const order: string[] = [];
    mgr.on('exit', () => order.push('exit'));
    settings = new ThreadSettings({
      ...(settings as any).deps,
      threads: { ...(settings as any).deps.threads, spawnTerminal: () => { order.push(`spawn:${cfg('t').transport ?? 'pty'}`); }, revokeAllKeys: () => { order.push('revoke'); } },
    });
    const out = await settings.switchTransport('t', 'pty');
    expect(order).toEqual(['exit', 'revoke', 'spawn:pty']);
    expect(cfg('t')).toEqual({ keep: 'me', wakeAt: 123 });
    expect(out.id).toBe('t');
  });

  it('a pick that the harness refused late is taken back only while it is still the saved pick', () => {
    new ThreadConfigStore(db).patch('t', { model: 'bad', modelSetAt: 1, effort: 'ultra', effortSetAt: 2 });
    settings.undoRefusedPick('t', { model: 'other' }); // not the saved pick: nothing changes
    expect(cfg('t').model).toBe('bad');
    expect(changed).toEqual([]);
    settings.undoRefusedPick('t', { model: 'bad', effort: 'ultra', restoredModel: 'good' });
    expect(cfg('t')).toEqual({ transport: 'structured', keep: 'me', wakeAt: 123, model: 'good' });
    expect(changed).toEqual(['s1']);
  });

  it('transportError carries the HTTP status', () => {
    const e = transportError(418, 'teapot');
    expect(e.status).toBe(418);
    expect(e.message).toBe('teapot');
  });
});
