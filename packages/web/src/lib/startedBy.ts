import type { Terminal } from '../api/types';

/**
 * Who started a thread, from its `config` alone (there is no created_by column on threads).
 * Mirrors `startedByOf` in packages/core/src/endless/pane.ts, which the Chat pane uses; keep the
 * two in step (the test table in startedBy.test.ts covers every case). Used by the phone Threads
 * view to split Mine from Agents and to word the "started by" line on agent rows.
 */
export type StartedBy = 'chat' | 'overseer' | 'thread' | 'role' | 'user';
export interface Started { startedBy: StartedBy; via: string | null }

type Cfg = Record<string, unknown>;
const cfgOf = (c: unknown): Cfg => (c && typeof c === 'object' && !Array.isArray(c) ? (c as Cfg) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** True for a thread that Chat, an overseer, another thread or a scheduled role started. */
export function isAgentStarted(config: unknown): boolean {
  const c = cfgOf(config);
  return c.role === 'agent' || c.origin === 'endless' || !!str(c.roleRun);
}

/** `find` looks a parent thread up by id (the parent is always in the same project). */
export function startedByOf(t: Pick<Terminal, 'config'>, find: (id: string) => Pick<Terminal, 'label' | 'config'> | null): Started {
  const c = cfgOf(t.config);
  if (c.origin === 'endless') return { startedBy: 'chat', via: null };
  if (str(c.roleRun)) return { startedBy: 'role', via: null };
  if (c.role !== 'agent') return { startedBy: 'user', via: null };
  const by = str(c.spawnedBy);
  if (!by) return { startedBy: 'overseer', via: null }; // rows from before spawnedBy existed
  const p = find(by);
  if (!p) return { startedBy: 'thread', via: null };
  const pc = cfgOf(p.config);
  if (pc.role === 'coordinator') return { startedBy: 'overseer', via: null };
  if (pc.origin === 'endless') return { startedBy: 'chat', via: p.label };
  return { startedBy: 'thread', via: p.label };
}

/** The words of the Chat pane (endless/ProjectsPanel.tsx originText). Empty for the owner. */
export function startedByText(s: Started): string {
  switch (s.startedBy) {
    case 'thread': return s.via ? `via ${s.via}` : 'via a thread';
    case 'chat': return s.via ? `Chat, via ${s.via}` : 'Chat';
    case 'overseer': return 'Overseer';
    case 'role': return 'Role';
    default: return '';
  }
}
