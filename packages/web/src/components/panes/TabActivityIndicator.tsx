import { useTabs, findTerminal } from '../../stores/tabs';
import { projectIndicator } from '../../lib/status';
import { Spinner } from '../common/Spinner';
import { StatusDot } from '../common/StatusDot';

/* Leading (favicon-style) activity glyph for a tab chip — mirrors the sidebar
   row's signals through the same projectIndicator rollup (needs_input > working
   > error > idle) so the two surfaces can never disagree. Renders nothing for
   idle tabs and for tabs with no backing terminal (files, virtual tabs). */

export function TabActivityIndicator({ tabId }: { tabId: string }) {
  const status = useTabs((s) => findTerminal(s.byProject, tabId)?.status);
  const loading = useTabs((s) => !!s.loading[tabId]);
  if (status === undefined && !loading) return null;
  return glyph(projectIndicator(undefined, status ? [status] : [], loading));
}

/** Group-chip variant: one glyph rolled up across the group's member tabs. */
export function GroupActivityIndicator({ tabIds }: { tabIds: string[] }) {
  const byProject = useTabs((s) => s.byProject);
  const loadingMap = useTabs((s) => s.loading);
  const statuses = tabIds.map((id) => findTerminal(byProject, id)?.status ?? '');
  return glyph(projectIndicator(undefined, statuses, tabIds.some((id) => !!loadingMap[id])));
}

function glyph(ind: ReturnType<typeof projectIndicator>) {
  if (ind === 'working') return <Spinner size={10} />;
  if (ind === 'needs_input' || ind === 'error') return <StatusDot state={ind} size={7} />;
  return null;
}
