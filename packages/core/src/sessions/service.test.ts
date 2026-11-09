import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { SessionService } from './service.js';
import { ThreadConfigStore } from './thread-config.js';

// W2-A: the config writes of SessionService go through ThreadConfigStore.
class FakePty extends EventEmitter {
  isAlive() { return false; }
  kill() {}
  spawn() { return 1; }
  setDefaultEnv() {}
}

const FULL = { transport: 'structured', role: 'agent', agentType: 'implementer', model: 'opus', alertsEnabled: true, mission: 'm', html: '<p>old</p>' };

let db: Database.Database;
let svc: SessionService;
const cfg = (id = 't1'): Record<string, any> => JSON.parse(terminalsDb.getById(db, id)!.config || '{}');

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 'S', provider: 'claude-code', name: 's', workingDir: '/tmp' });
  terminalsDb.create(db, { id: 't1', sessionId: 'S', type: 'notes', label: 't', config: FULL });
  svc = new SessionService(db, new FakePty() as any, '/tmp/w2a-test-mcp.json');
});
afterEach(() => { vi.restoreAllMocks(); });

describe('SessionService.updateTab', () => {
  it('updateTab with a partial config keeps the other keys', () => {
    const out = svc.updateTab('t1', { config: { html: '<p>new</p>' } });
    expect(out?.config).toEqual({ ...FULL, html: '<p>new</p>' });
    expect(cfg()).toEqual({ ...FULL, html: '<p>new</p>' });
  });

  it('updateTab ignores a key outside the allow-list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    svc.updateTab('t1', { config: { html: '<p>new</p>', role: 'coordinator', secretsEnv: true, autonomy: 'autonomous', queuedTask: 'rm -rf' } });
    expect(cfg()).toEqual({ ...FULL, html: '<p>new</p>' });
    // The ignored keys are logged by name, never by value.
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/role/);
    expect(logged).toMatch(/secretsEnv/);
    expect(logged).not.toMatch(/rm -rf/);
  });

  it('updateTab with the whole config the web notes tab sends (a stale copy) changes only its own key', () => {
    // NotesTab sends { ...terminal.config, html }: its copy of the other keys can be old.
    new ThreadConfigStore(db).patch('t1', { scheduledWake: 'written after the page loaded' });
    svc.updateTab('t1', { config: { ...FULL, html: '<p>typed</p>' } });
    expect(cfg()).toEqual({ ...FULL, html: '<p>typed</p>', scheduledWake: 'written after the page loaded' });
  });

  it('updateTab removes a client key that is sent as null', () => {
    svc.updateTab('t1', { config: { html: null } });
    const { html: _html, ...rest } = FULL;
    expect(cfg()).toEqual(rest);
  });

  it('updateTab with a label only does not touch the config', () => {
    svc.updateTab('t1', { label: 'renamed' });
    expect(terminalsDb.getById(db, 't1')!.label).toBe('renamed');
    expect(cfg()).toEqual(FULL);
  });

  it('updateTab ignores a config that is not an object', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    svc.updateTab('t1', { config: 'text' as any });
    svc.updateTab('t1', { config: [1, 2] as any });
    expect(cfg()).toEqual(FULL);
  });
});

describe('SessionService config writes name their keys', () => {
  const store = () => new ThreadConfigStore(db);

  it('uses the store given in the constructor option', () => {
    const given = store();
    const patch = vi.spyOn(given, 'patch');
    const s = new SessionService(db, new FakePty() as any, '/tmp/w2a-test-mcp.json', { configStore: given });
    s.setAlertsEnabled('t1', false);
    expect(patch).toHaveBeenCalled();
    expect(cfg().alertsEnabled).toBeUndefined();
  });

  it('setAutoArchive, setAlertsEnabled, setAutonomy, setBoardState and noteTurnOutcome each keep the other keys', () => {
    svc.setAutoArchive('t1', true, 5000);
    svc.setAlertsEnabled('t1', false);
    svc.setAutonomy('t1', 'autonomous');
    svc.setBoardState('t1', { acknowledged: true, override: 'complete' });
    svc.noteTurnOutcome('t1', { summary: 'done', needsHelp: false, inferred: true });
    const { alertsEnabled: _a, ...rest } = FULL;
    const after = cfg();
    expect(after).toMatchObject({ ...rest, autoArchive: true, autoArchiveMs: 5000, autonomy: 'autonomous' });
    expect(after.alertsEnabled).toBeUndefined();
    expect(after.boardState.override).toBe('complete');
    expect(typeof after.boardState.acknowledgedAt).toBe('string');
    expect(after.lastOutcome).toMatchObject({ summary: 'done', needsHelp: false, inferred: true });

    svc.setAutoArchive('t1', false);
    svc.setBoardState('t1', { acknowledged: false });
    const end = cfg();
    expect(end.autoArchive).toBeUndefined();
    expect(end.autoArchiveMs).toBeUndefined();
    expect(end.boardState).toEqual({ override: 'complete' });
    expect(end).toMatchObject(rest);
  });

  it('reportStatus on a thread with no live process keeps the other keys', () => {
    expect(svc.reportStatus('t1', { state: 'done', summary: 'shipped' })).toBe(true);
    expect(cfg()).toEqual({ ...FULL, pendingDeclaration: { state: 'done', summary: 'shipped' } });
  });

  it('a setter on a missing thread answers as before and writes nothing', () => {
    expect(svc.setAutoArchive('nope', true)).toBeNull();
    expect(svc.setAlertsEnabled('nope', true)).toBeNull();
    expect(svc.setAutonomy('nope', 'autonomous')).toBe(false);
    expect(svc.setBoardState('nope', { override: 'complete' })).toBe(false);
    expect(svc.reportStatus('nope', { state: 'done', summary: 'x' })).toBe(false);
  });
});
