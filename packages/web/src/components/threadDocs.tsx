import { createContext, useContext, useMemo } from 'react';
import type { DocChips } from './Markdown';
import { useProjects } from '../stores/projects';
import { useDocViewer } from '../stores/docViewer';
import { projectForPath } from '../lib/docPaths';
import { classifyLink } from '../lib/docLinks';

type Projects = { id: string; folder: string }[];

/**
 * The doc chips and link handling of a thread's messages, for every harness and agent type: a doc
 * path or a link to a doc in the project opens the doc viewer in place (the thread's own viewer, see
 * `origin`), a web link opens a new tab, and every other link does nothing.
 */
export function threadDocChips(project: string | null, projects: Projects, origin: string | undefined, from?: string): DocChips {
  return {
    accept: (p) => projectForPath(p, project, projects) !== null,
    onOpen: (p, b) => {
      const target = projectForPath(p, project, projects);
      if (target) useDocViewer.getState().show({ project: target, path: p, branch: b, origin });
    },
    link: (href) => classifyLink(href, { project, projects, from }),
  };
}

/**
 * Provided by a view; read by every <Markdown> under it (see Markdown). Absent: links still never
 * navigate the app, but no doc opens. `origin` names the doc viewer that shows the doc (none: Chat's).
 */
export const ThreadDocsContext = createContext<DocChips | undefined>(undefined);
export const useThreadDocs = () => useContext(ThreadDocsContext);

/** A view's chips, stable until its project or the project folders change. No project: only an absolute path in a registered project opens. */
export function useThreadDocChips(project: string | null | undefined, origin: string | undefined, from?: string): DocChips {
  const sessions = useProjects((s) => s.sessions);
  const key = JSON.stringify(sessions.map((s) => [s.id, s.workingDir]));
  return useMemo(() => {
    const projects = (JSON.parse(key) as [string, string][]).map(([id, folder]) => ({ id, folder }));
    return threadDocChips(project ?? null, projects, origin, from);
  }, [project, key, origin, from]);
}
