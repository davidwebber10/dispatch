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
export function threadDocChips(project: string | null, projects: Projects, origin: string): DocChips {
  return {
    accept: (p) => projectForPath(p, project, projects) !== null,
    onOpen: (p, b) => {
      const target = projectForPath(p, project, projects);
      if (target) useDocViewer.getState().show({ project: target, path: p, branch: b, origin });
    },
    link: (href) => classifyLink(href, { project, projects }),
  };
}

/** Provided by a thread view; read by the message renderers under it. Absent: no chips, links as before. */
export const ThreadDocsContext = createContext<DocChips | undefined>(undefined);
export const useThreadDocs = () => useContext(ThreadDocsContext);

/** The thread's chips, stable until its project or the project folders change. */
export function useThreadDocChips(project: string | undefined, terminalId: string): DocChips | undefined {
  const sessions = useProjects((s) => s.sessions);
  const key = JSON.stringify(sessions.map((s) => [s.id, s.workingDir]));
  return useMemo(() => {
    if (!project) return undefined;
    const projects = (JSON.parse(key) as [string, string][]).map(([id, folder]) => ({ id, folder }));
    return threadDocChips(project, projects, terminalId);
  }, [project, key, terminalId]);
}
