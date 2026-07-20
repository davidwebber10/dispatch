// Cross-project data hook for the thread board: folds EVERY project's terminals — not just the
// active one — through `boardColumn`/`toBoardCard`, keyed live by `useThreadStatus`. Nothing here
// invents a new subscription: live status already broadcasts to every client with no project
// scope (see useThreadStatus), and the cross-project LOAD pattern is copied verbatim from
// components/mobile/PinnedThreadsView.tsx:22-36 rather than reinvented. Deliberately does NOT
// reuse useRenderVals()/overseer/store.ts — that store is hard-scoped to the active project
// (~store.ts:642) and architected around one active coordinator, not a global fold.

import { useEffect, useMemo, useState } from 'react';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useThreadStatus } from '../../stores/threadStatus';
import { toBoardCard, type BoardCardModel, type BoardColumn } from './boardColumn';

export interface BoardData {
  columns: Record<BoardColumn, BoardCardModel[]>;
  loading: boolean;
  projects: { id: string; name: string }[];
}

/**
 * `projectFilter`: a single project id to scope the board down to, or `null` for every
 * project (the default "All projects" view — see the spec's "Data — all projects, filterable").
 */
export function useBoardData(projectFilter: string | null): BoardData {
  const sessions = useProjects((s) => s.sessions);
  const byProject = useTabs((s) => s.byProject);
  const byTerminal = useThreadStatus((s) => s.byTerminal);
  const [loading, setLoading] = useState(true);

  // Keyed on the project IDS, not the `sessions` array — the store replaces that array on
  // every unrelated update (rename, reorder, status), which would re-fetch every project's
  // tabs each time.
  const projectIds = sessions.map((p) => p.id).join(',');

  useEffect(() => {
    let alive = true;
    const ids = projectIds ? projectIds.split(',') : [];
    Promise.all(ids.map((id) => useTabs.getState().loadTabs(id).catch(() => { /* project gone */ })))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // NOT mount-only. `useProjects.load()` is async and fires from the app root, so a board
    // that mounts at startup — which is exactly what happens on mobile when the saved view
    // mode is already 'board' — runs this effect before any project exists and would sit
    // permanently empty. Re-running when the project set arrives is what makes it fill in.
  }, [projectIds]);

  const columns = useMemo(() => {
    const cols: Record<BoardColumn, BoardCardModel[]> = {
      needs_help: [],
      complete: [],
      working: [],
      resting: [],
    };
    for (const project of sessions) {
      if (projectFilter && project.id !== projectFilter) continue;
      const terminals = byProject[project.id] ?? [];
      for (const t of terminals) {
        const card = toBoardCard(t, project.id, project.name, byTerminal[t.id]);
        cols[card.column].push(card);
      }
    }
    return cols;
    // `sessions` drives which projects/names to fold in; it's stable outside a project
    // create/rename, so this stays effectively memoized on [byProject, byTerminal, projectFilter]
    // as the brief specifies, plus sessions for correctness when the project list itself changes.
  }, [byProject, byTerminal, sessions, projectFilter]);

  const projects = useMemo(
    () => sessions.map((p) => ({ id: p.id, name: p.name })),
    [sessions],
  );

  return { columns, loading, projects };
}
