import { create } from 'zustand';

/**
 * Projects ⇄ Threads (2026-11-07): the phone's switch, now on the desktop too, above the search line
 * of the left panel. One choice per device; the rail's first item and the phone's first tab are
 * named after it. Threads lists every thread of every project, last active first.
 */
export type ProjectsViewKind = 'projects' | 'threads';
const KEY = 'dispatch:projectsView';
const OLD_KEY = 'dispatch:mobileProjectsView';
const read = (): ProjectsViewKind => {
  try { return (localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY)) === 'threads' ? 'threads' : 'projects'; } catch { return 'projects'; }
};

export const useProjectsView = create<{ view: ProjectsViewKind; setView(v: ProjectsViewKind): void }>((set) => ({
  view: read(),
  setView: (view) => { try { localStorage.setItem(KEY, view); } catch { /* ignore */ } set({ view }); },
}));
