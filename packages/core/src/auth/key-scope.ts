import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import { isAgentType } from '../providers/agent-types.js';

/**
 * Database facts for a key caller and a target (spec 6.4). The principal middleware takes a scope
 * as a parameter, so tests can stub it.
 */
export interface CallerFacts {
  id: string; sessionId: string; type: string; role: string | null;
  depth: number;            // effective depth (legacy rules applied)
  spawnedBy: string | null; // null when it names no live thread in the same project
  origin: string | null; roleRun: boolean; archived: boolean;
  overseer: boolean;        // role coordinator, not archived, not a role run (PK-4)
}

export interface KeyScope {
  caller(terminalId: string): CallerFacts | null;
  target(terminalId: string): CallerFacts | null;
  isCoordinatorOfProject(caller: CallerFacts, sessionId: string): boolean;
  mayDirect(caller: CallerFacts, target: CallerFacts): boolean;
  mayRead(caller: CallerFacts, sessionId: string): boolean;
  mayMessage(caller: CallerFacts, target: CallerFacts): boolean;
}

/** Placeholder for tests: every lookup finds nothing and every rule says no. */
export const nullKeyScope: KeyScope = {
  caller: () => null,
  target: () => null,
  isCoordinatorOfProject: () => false,
  mayDirect: () => false,
  mayRead: () => false,
  mayMessage: () => false,
};

const MAX_DEPTH = 3;

/**
 * Spawn depth with the legacy record rules (spec 6.1). Missing and no parent: 0 (root
 * thread, as the spawn path always counted it). Missing with a parent, not an integer, or
 * outside 0 to 3: 3, so the thread cannot spawn.
 */
export function effectiveSpawnDepth(config: Record<string, any> | null | undefined): number {
  const c = config ?? {};
  const d = c.spawnDepth;
  if (d === undefined || d === null) return c.spawnedBy ? MAX_DEPTH : 0;
  if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > MAX_DEPTH) return MAX_DEPTH;
  return d;
}

/**
 * The project's live coordinator thread: the first unarchived agent-harness row with
 * `config.role === 'coordinator'` in sort order. The one predicate for `findCoordinator`,
 * the overseer test, `isCoordinatorOfProject` and `mayMessage`.
 */
export function findLiveCoordinator(db: Database.Database, sessionId: string): terminalsDb.Terminal | null {
  return terminalsDb.listBySession(db, sessionId)
    .map(terminalsDb.rowToTerminal)
    .find((t) => isAgentType(t.type) && t.config?.role === 'coordinator') ?? null;
}

export function createKeyScope(db: Database.Database): KeyScope {
  function facts(id: string): CallerFacts | null {
    const row = terminalsDb.getById(db, id);
    if (!row) return null;
    const t = terminalsDb.rowToTerminal(row);
    const cfg = t.config ?? {};
    let spawnedBy: string | null = null;
    if (typeof cfg.spawnedBy === 'string' && cfg.spawnedBy) {
      const parent = terminalsDb.getById(db, cfg.spawnedBy);
      if (parent && parent.session_id === t.sessionId) spawnedBy = parent.id;
    }
    const roleRun = !!cfg.roleRun;
    const archived = !!t.archivedAt;
    const role = typeof cfg.role === 'string' ? cfg.role : null;
    const overseer = role === 'coordinator' && !archived && !roleRun
      && findLiveCoordinator(db, t.sessionId)?.id === t.id;
    return {
      id: t.id, sessionId: t.sessionId, type: t.type, role,
      depth: effectiveSpawnDepth(cfg), spawnedBy,
      origin: typeof cfg.origin === 'string' ? cfg.origin : null,
      roleRun, archived, overseer,
    };
  }

  const isCoordinatorOfProject: KeyScope['isCoordinatorOfProject'] = (caller, sessionId) =>
    caller.overseer && caller.sessionId === sessionId
    && findLiveCoordinator(db, sessionId)?.id === caller.id;

  return {
    // An archived caller has no key rights; a target may be archived (the rules decide).
    caller: (id) => { const f = facts(id); return f && !f.archived ? f : null; },
    target: facts,
    isCoordinatorOfProject,
    mayDirect: (caller, target) =>
      target.id !== caller.id
      && target.sessionId === caller.sessionId
      && (target.spawnedBy === caller.id || isCoordinatorOfProject(caller, target.sessionId)),
    mayRead: (caller, sessionId) => caller.overseer || caller.sessionId === sessionId,
    mayMessage: (caller, target) => {
      if (target.id === caller.id || target.type === 'shell') return false;
      if (target.sessionId === caller.sessionId) return true;
      return caller.overseer && target.overseer;
    },
  };
}
