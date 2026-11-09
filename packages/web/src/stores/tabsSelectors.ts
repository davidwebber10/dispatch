import { useShallow } from 'zustand/react/shallow';
import type { Terminal } from '../api/types';
import { projectIndicator, type ProjectIndicator } from '../lib/status';
import { useTabs, isDispatchTab, dispatchSessionId } from './tabs';

/**
 * Narrow reads of the tabs store (W1-F).
 *
 * `useTabs((s) => s.byProject)` notifies on EVERY change to any thread of any project. A
 * `terminal:status` event fires each time an agent flips working<->idle, so a component that
 * selects the whole map renders constantly for threads it does not show. Each hook here selects
 * the smallest value a component needs, so it notifies only when that value changes:
 * `applyEvent` (stores/tabs.ts) keeps the identity of every array and row it does not touch.
 *
 * A component that really needs every project (a cross-project list) keeps the full selector and
 * says why in a comment.
 */

type ByProject = Record<string, Terminal[]>;

const EMPTY: Terminal[] = [];

// id -> terminal, built once per `byProject` object. Each store change that replaces the map
// costs one O(threads) pass; after that every by-id hook is an O(1) lookup instead of a scan
// of every project per hook per change.
const indexes = new WeakMap<ByProject, Map<string, Terminal>>();
function indexOf(byProject: ByProject): Map<string, Terminal> {
  let idx = indexes.get(byProject);
  if (!idx) {
    idx = new Map();
    for (const list of Object.values(byProject)) for (const t of list) if (!idx.has(t.id)) idx.set(t.id, t);
    indexes.set(byProject, idx);
  }
  return idx;
}

/** The terminal with this id, from any project. Same result as `findTerminal`, O(1) after the first read. */
export function lookupTerminal(byProject: ByProject, id: string | null | undefined): Terminal | undefined {
  return id ? indexOf(byProject).get(id) : undefined;
}

/** The threads of one project. Notifies only when that project's list changes. */
export function useProjectTabs(projectId: string | null | undefined): Terminal[] {
  return useTabs(useShallow((s) => (projectId ? s.byProject[projectId] : undefined) ?? EMPTY));
}

/** One terminal. Notifies when that row is replaced (its status, label or config changed). */
export function useTerminal(id: string | null | undefined): Terminal | undefined {
  return useTabs((s) => lookupTerminal(s.byProject, id));
}

/** One terminal's status. */
export function useTerminalStatus(id: string | null | undefined): Terminal['status'] | undefined {
  return useTabs((s) => lookupTerminal(s.byProject, id)?.status);
}

/** One terminal's label. A status change does not notify. */
export function useTerminalLabel(id: string | null | undefined): string | undefined {
  return useTabs((s) => lookupTerminal(s.byProject, id)?.label);
}

/** The labels of several terminals, in order (undefined for one that is not loaded). A status change does not notify. */
export function useTerminalLabels(ids: string[]): (string | undefined)[] {
  return useTabs(useShallow((s) => ids.map((id) => lookupTerminal(s.byProject, id)?.label)));
}

/** The project that holds a terminal. */
export function useTerminalProjectId(id: string | null | undefined): string | undefined {
  return useTabs((s) => lookupTerminal(s.byProject, id)?.sessionId);
}

/** The project of a tab id: as `useTerminalProjectId`, and the virtual Dispatch tab answers its own project. */
export function useTabProjectId(id: string | null | undefined): string | undefined {
  return useTabs((s) => (id && isDispatchTab(id) ? dispatchSessionId(id) : lookupTerminal(s.byProject, id)?.sessionId));
}

/** The project of each tab id, in order (the virtual Dispatch tab answers its own project). */
export function useTabProjectIds(ids: string[]): (string | undefined)[] {
  return useTabs(useShallow((s) => ids.map((id) => (isDispatchTab(id) ? dispatchSessionId(id) : lookupTerminal(s.byProject, id)?.sessionId))));
}

/** The statuses of several terminals, in order ('' for one that is not loaded), and whether any of them is starting. */
export function useTerminalsIndicator(ids: string[]): ProjectIndicator {
  return useTabs((s) => projectIndicator(undefined, ids.map((id) => lookupTerminal(s.byProject, id)?.status ?? ''), ids.some((id) => !!s.loading[id])));
}

/**
 * A project's rolled-up indicator (needs_input > working > error > idle), from its live threads
 * and their "starting" flags. `sessionStatus` adds the daemon's own rollup; `include` leaves
 * threads out (the sidebar hides the managed ones). The result is a primitive, so a change that
 * keeps the rollup (a second thread starts work) does not notify.
 */
export function useProjectIndicator(projectId: string, sessionStatus?: string, include?: (t: Terminal) => boolean): ProjectIndicator {
  return useTabs((s) => {
    const all = s.byProject[projectId] ?? EMPTY;
    const tabs = include ? all.filter(include) : all;
    return projectIndicator(sessionStatus, tabs.map((t) => t.status), tabs.some((t) => !!s.loading[t.id]));
  });
}
