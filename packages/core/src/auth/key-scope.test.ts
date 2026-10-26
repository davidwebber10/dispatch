import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as terminalsDb from '../db/terminals.js';
import * as sessionsDb from '../db/sessions.js';
import { createKeyScope, effectiveSpawnDepth, type KeyScope } from './key-scope.js';

describe('effectiveSpawnDepth', () => {
  it('applies the legacy record rules', () => {
    expect(effectiveSpawnDepth({})).toBe(0);
    expect(effectiveSpawnDepth({ spawnDepth: 2 })).toBe(2);
    expect(effectiveSpawnDepth({ spawnedBy: 'p' })).toBe(3);
    expect(effectiveSpawnDepth({ spawnDepth: 7 })).toBe(3);
    expect(effectiveSpawnDepth({ spawnDepth: 'x' })).toBe(3);
    expect(effectiveSpawnDepth({ spawnDepth: 1.5 })).toBe(3);
    expect(effectiveSpawnDepth({ spawnDepth: -1 })).toBe(3);
  });
});

describe('createKeyScope', () => {
  let db: Database.Database;
  let scope: KeyScope;
  const mk = (id: string, sessionId: string, config: Record<string, any> = {}, type = 'claude-code') =>
    terminalsDb.create(db, { id, sessionId, type, label: id, config });

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    for (const id of ['A', 'B']) sessionsDb.create(db, { id, provider: 'claude-code', name: `proj-${id}`, workingDir: '/tmp' } as any);
    scope = createKeyScope(db);
  });

  it('reads depth and parent from the database', () => {
    mk('w1', 'A', { spawnDepth: 7, spawnedBy: 'ghost' });
    mk('w2', 'A', { spawnedBy: 'w1' });
    mk('w3', 'A', { spawnDepth: 1, spawnedBy: 'foreign' });
    mk('foreign', 'B');
    mk('root', 'A', { role: 'coordinator' });
    expect(scope.caller('w1')).toMatchObject({ depth: 3, spawnedBy: null });
    expect(scope.caller('w2')).toMatchObject({ depth: 3, spawnedBy: 'w1' });
    expect(scope.caller('w3')).toMatchObject({ depth: 1, spawnedBy: null });
    expect(scope.caller('root')).toMatchObject({ depth: 0, spawnedBy: null });
    expect(scope.caller('nope')).toBeNull();
  });

  it('flags only the live coordinator as overseer', () => {
    mk('c1', 'A', { role: 'coordinator' });
    mk('c2', 'A', { role: 'coordinator' });
    terminalsDb.updateSortOrder(db, 'c1', 1);
    terminalsDb.updateSortOrder(db, 'c2', 2);
    mk('run', 'B', { role: 'coordinator', roleRun: true });
    mk('c3', 'B', { role: 'coordinator' });
    mk('old', 'B', { role: 'coordinator' });
    terminalsDb.updateSortOrder(db, 'run', 3);
    terminalsDb.updateSortOrder(db, 'c3', 2);
    terminalsDb.archive(db, 'old');
    mk('w', 'A', { role: 'agent' });
    mk('plain', 'A');
    expect(scope.target('c1')!.overseer).toBe(true);
    expect(scope.target('c2')!.overseer).toBe(false);
    expect(scope.target('run')!.overseer).toBe(false);
    expect(scope.target('c3')!.overseer).toBe(true);
    expect(scope.target('old')!.overseer).toBe(false);
    expect(scope.target('w')!.overseer).toBe(false);
    expect(scope.target('plain')!.overseer).toBe(false);
    expect(scope.caller('old')).toBeNull();
  });

  it('mayDirect', () => {
    mk('cA', 'A', { role: 'coordinator' });
    mk('w1', 'A', { spawnedBy: 'cA', spawnDepth: 1 });
    mk('w2', 'A', { spawnedBy: 'cA', spawnDepth: 1 });
    mk('w1kid', 'A', { spawnedBy: 'w1', spawnDepth: 2 });
    mk('cB', 'B', { role: 'coordinator' });
    const w1 = scope.caller('w1')!, cA = scope.caller('cA')!;
    expect(scope.mayDirect(w1, scope.target('w1kid')!)).toBe(true);
    expect(scope.mayDirect(cA, scope.target('w1')!)).toBe(true);
    expect(scope.mayDirect(cA, scope.target('w1kid')!)).toBe(true);
    expect(scope.mayDirect(w1, scope.target('w1')!)).toBe(false);
    expect(scope.mayDirect(w1, scope.target('w2')!)).toBe(false);
    expect(scope.mayDirect(cA, scope.target('cB')!)).toBe(false);
    // the owner moves a worker to another project
    terminalsDb.updateSessionId(db, 'w1kid', 'B');
    expect(scope.mayDirect(w1, scope.target('w1kid')!)).toBe(false);
    expect(scope.mayDirect(cA, scope.target('w1kid')!)).toBe(false);
  });

  it('mayRead and mayMessage', () => {
    mk('cA', 'A', { role: 'coordinator' });
    mk('wA', 'A', { spawnedBy: 'cA', spawnDepth: 1 });
    mk('cB', 'B', { role: 'coordinator' });
    mk('wB', 'B', { spawnedBy: 'cB', spawnDepth: 1 });
    mk('pB', 'B');
    mk('shA', 'A', {}, 'shell');
    const cA = scope.caller('cA')!, wA = scope.caller('wA')!;
    expect(scope.mayRead(cA, 'B')).toBe(true);
    expect(scope.mayRead(wA, 'B')).toBe(false);
    expect(scope.mayRead(wA, 'A')).toBe(true);
    expect(scope.mayMessage(cA, scope.target('cB')!)).toBe(true);
    expect(scope.mayMessage(cA, scope.target('wB')!)).toBe(false);
    expect(scope.mayMessage(cA, scope.target('pB')!)).toBe(false);
    expect(scope.mayMessage(wA, scope.target('cB')!)).toBe(false);
    expect(scope.mayMessage(wA, scope.target('cA')!)).toBe(true);
    expect(scope.mayMessage(wA, scope.target('wA')!)).toBe(false);
    expect(scope.mayMessage(wA, scope.target('shA')!)).toBe(false);
    expect(scope.isCoordinatorOfProject(cA, 'A')).toBe(true);
    expect(scope.isCoordinatorOfProject(cA, 'B')).toBe(false);
    expect(scope.isCoordinatorOfProject(wA, 'A')).toBe(false);
  });
});
