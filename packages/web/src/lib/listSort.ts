import type { AgentSchedule, Terminal } from '../api/types';

export type ThreadSort = 'needs' | 'active' | 'newest' | 'oldest' | 'name' | 'custom';
export type AgentSort = 'next' | 'updated' | 'newest' | 'oldest' | 'name';

export const THREAD_SORTS: readonly (readonly [ThreadSort, string])[] = [
  ['needs', 'Needs you first'],
  ['active', 'Recently active'],
  ['newest', 'Newest'],
  ['oldest', 'Oldest'],
  ['name', 'Name (A–Z)'],
  ['custom', 'Custom'],
];

export const AGENT_SORTS: readonly (readonly [AgentSort, string])[] = [
  ['next', 'Next run'],
  ['updated', 'Recently updated'],
  ['newest', 'Newest'],
  ['oldest', 'Oldest'],
  ['name', 'Name (A–Z)'],
];

/** Threads default to the server's own order, so nothing moves until the user picks a sort. */
export const DEFAULT_THREAD_SORT: ThreadSort = 'custom';
/** Automations have no meaningful stored order, so lead with the question a schedule list answers. */
export const DEFAULT_AGENT_SORT: AgentSort = 'next';

/** An unparseable or absent timestamp must not yield NaN — a NaN comparison is
 *  non-transitive and makes the whole sort order arbitrary. Missing sinks to the bottom. */
function ms(iso: string | null | undefined, missing: number): number {
  if (!iso) return missing;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : missing;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Every comparator ends here so equal keys can never reshuffle between renders. */
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function threadActivity(t: Terminal): number {
  return ms(t.lastActivityAt ?? t.createdAt, 0);
}

export function sortThreads(items: Terminal[], mode: ThreadSort): Terminal[] {
  const out = [...items];
  switch (mode) {
    case 'needs':
      return out.sort((a, b) => {
        const an = a.status === 'needs_input' ? 0 : 1;
        const bn = b.status === 'needs_input' ? 0 : 1;
        return an - bn || threadActivity(b) - threadActivity(a) || byId(a, b);
      });
    case 'active':
      return out.sort((a, b) => threadActivity(b) - threadActivity(a) || byId(a, b));
    case 'newest':
      return out.sort((a, b) => ms(b.createdAt, 0) - ms(a.createdAt, 0) || byId(a, b));
    case 'oldest':
      return out.sort((a, b) => ms(a.createdAt, Infinity) - ms(b.createdAt, Infinity) || byId(a, b));
    case 'name':
      return out.sort((a, b) => collator.compare(a.label, b.label) || byId(a, b));
    case 'custom':
    default:
      // sort_order is DEFAULT 0 and never set on insert, so an untouched project ties
      // every row at 0; createdAt is the tiebreak the server itself uses.
      return out.sort((a, b) => a.sortOrder - b.sortOrder || ms(a.createdAt, Infinity) - ms(b.createdAt, Infinity) || byId(a, b));
  }
}

export function sortAgents(items: AgentSchedule[], mode: AgentSort): AgentSchedule[] {
  const out = [...items];
  switch (mode) {
    case 'updated':
      return out.sort((a, b) => ms(b.updatedAt, 0) - ms(a.updatedAt, 0) || byId(a, b));
    case 'newest':
      return out.sort((a, b) => ms(b.createdAt, 0) - ms(a.createdAt, 0) || byId(a, b));
    case 'oldest':
      return out.sort((a, b) => ms(a.createdAt, Infinity) - ms(b.createdAt, Infinity) || byId(a, b));
    case 'name':
      return out.sort((a, b) => collator.compare(a.name, b.name) || byId(a, b));
    case 'next':
    default:
      // A disabled schedule has nextRunAt === null; those belong at the end.
      return out.sort((a, b) => ms(a.nextRunAt, Infinity) - ms(b.nextRunAt, Infinity) || byId(a, b));
  }
}
