/**
 * Database facts for a key caller and a target (spec 6.4). Task 7 supplies the real
 * implementation; Task 5 only needs the shape, so the principal middleware can take a scope
 * as a parameter and tests can stub it.
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

/** Placeholder until Task 7: every lookup finds nothing and every rule says no. */
export const nullKeyScope: KeyScope = {
  caller: () => null,
  target: () => null,
  isCoordinatorOfProject: () => false,
  mayDirect: () => false,
  mayRead: () => false,
  mayMessage: () => false,
};
