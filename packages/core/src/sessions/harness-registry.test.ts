// HarnessRegistry alone: built from its typed inputs, with no SessionService.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { ThreadConfigStore } from './thread-config.js';
import { emptySessionWiring, type SessionWiring } from './session-wiring.js';
import { HarnessRegistry } from './harness-registry.js';

let db: Database.Database;
let wiring: SessionWiring;
let undone: unknown[][];
let reg: HarnessRegistry;

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/nowhere' });
  terminalsDb.create(db, { id: 'cx', sessionId: 's1', type: 'codex', label: 'cx', config: { transport: 'structured' } });
  wiring = emptySessionWiring();
  undone = [];
  reg = new HarnessRegistry({ db, configStore: new ThreadConfigStore(db), wiring, threads: { undoRefusedPick: (...a) => { undone.push(a); } } });
});
afterEach(() => { db.close(); });

describe('HarnessRegistry', () => {
  it('finds the manager of a type and of a thread', () => {
    const m = new EventEmitter();
    reg.registerStructuredManager('codex', m as any);
    expect(reg.structuredManagerFor('codex')).toBe(m);
    expect(reg.structuredManagerForTerminal('cx')).toBe(m);
    expect(reg.structuredManagerForTerminal('nope')).toBeUndefined();
  });

  it('a refused pick goes to the given undo; the session id and a restarted pid are saved', () => {
    const m = new EventEmitter();
    reg.registerStructuredManager('codex', m as any);
    m.emit('settings-refused', 'cx', { model: 'm' });
    m.emit('session', 'cx', 'thread-1');
    m.emit('process-restarted', 'cx', 99);
    expect(undone).toEqual([['cx', { model: 'm' }]]);
    expect(terminalsDb.getById(db, 'cx')!.external_id).toBe('thread-1');
    expect(terminalsDb.getById(db, 'cx')!.pid).toBe(99);
  });

  it('the usage-limit service and the keys are read from the wiring at each event, so a late wire is seen', () => {
    const m = new EventEmitter();
    reg.registerStructuredManager('codex', m as any);
    const ended: string[] = [];
    wiring.usageLimits = { onTurnEnded: (id: string) => ended.push(id) } as any;
    m.emit('idle', 'cx');
    expect(ended).toEqual(['cx']);
    expect(m.listenerCount('exit')).toBe(0); // no key registry yet
    const revoked: string[] = [];
    wiring.threadKeys = { onStructuredExit: (id: string) => revoked.push(id) } as any;
    reg.revokeKeysOnExitForAll();
    reg.revokeKeysOnExitForAll(); // once per manager
    m.emit('exit', 'cx');
    expect(revoked).toEqual(['cx']);
  });
});
