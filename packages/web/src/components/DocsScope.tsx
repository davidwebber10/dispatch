import type { ReactNode } from 'react';
import { DocViewer } from './endless/DocViewer';
import { ThreadDocsContext, useThreadDocChips } from './threadDocs';

/**
 * A view whose messages hold doc links: every <Markdown> under it opens a doc in this view's own doc
 * viewer (`origin` names it). `project` is where a relative link reads from; none: only an absolute
 * path in a registered project opens. `from` is the repo path of the doc the text is in.
 */
export function DocsScope({ project = null, origin, from, children }: { project?: string | null; origin: string; from?: string; children: ReactNode }) {
  const chips = useThreadDocChips(project, origin, from);
  return (
    <ThreadDocsContext.Provider value={chips}>
      {children}
      <DocViewer owner={origin} />
    </ThreadDocsContext.Provider>
  );
}
