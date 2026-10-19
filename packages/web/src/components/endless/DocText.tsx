import { Fragment } from 'react';
import { findDocPaths, docName, projectForPath, type DocSpan } from '../../lib/docPaths';
import { useDocViewer } from '../../stores/docViewer';
import { useEndless } from '../../stores/endless';

type Projects = { id: string; folder: string }[];

/**
 * The doc paths in `text` that are links (spec 12.2): an absolute path inside a registered project's
 * folder, or a relative path when the message has a project. A relative path with no project is not a link.
 */
export function docLinks(text: string, messageProject: string | null, projects: Projects): DocSpan[] {
  return findDocPaths(text).filter((s) => projectForPath(s.path, messageProject, projects) !== null);
}

/** Open a doc path from Chat in the doc viewer. The chip never checks the file first. */
export function openDoc(path: string, branch: string | null, messageProject: string | null): void {
  const project = projectForPath(path, messageProject, useEndless.getState().projects);
  if (project) useDocViewer.getState().show({ project, path, branch });
}

/** One doc chip (board ChatStates S6): the file name, the full path in its title. A click never reaches the card under it. */
export function DocChip({ span, project, raised }: { span: DocSpan; project: string | null; raised?: boolean }) {
  const name = docName(span.path);
  return (
    <button type="button" className="doc-chip" aria-label={name} title={span.path} data-doc-path={span.path}
      style={raised ? { background: 'var(--color-hover)' } : undefined}
      onClick={(e) => { e.stopPropagation(); openDoc(span.path, span.branch, project); }}
      onKeyDown={(e) => e.stopPropagation()}>
      {name}
    </button>
  );
}

/** Plain text with each doc link drawn as a chip; the rest of the text stays as it is. `raised`: on an elevated card (board ReportOpen). */
export function DocText({ text, project, raised }: { text: string; project: string | null; raised?: boolean }) {
  const projects = useEndless((s) => s.projects);
  const spans = docLinks(text, project, projects);
  if (!spans.length) return <>{text}</>;
  let last = 0;
  return (
    <>
      {spans.map((s) => {
        const before = text.slice(last, s.start);
        last = s.end;
        return <Fragment key={s.start}>{before}<DocChip span={s} project={project} raised={raised} /></Fragment>;
      })}
      {text.slice(last)}
    </>
  );
}
