import { useTabs } from '../../stores/tabs';
import { useTerminalStatus, useTerminalsIndicator } from '../../stores/tabsSelectors';
import { projectIndicator } from '../../lib/status';
import { Spinner } from '../common/Spinner';
import { StatusDot } from '../common/StatusDot';

/* Leading (favicon-style) activity glyph for a tab chip — mirrors the sidebar
   row's signals through the same projectIndicator rollup (needs_input > working
   > error > idle) so the two surfaces can never disagree. Renders nothing for
   idle tabs and for tabs with no backing terminal (files, virtual tabs). */

export function TabActivityIndicator({ tabId }: { tabId: string }) {
  const status = useTerminalStatus(tabId);
  const loading = useTabs((s) => !!s.loading[tabId]);
  if (status === undefined && !loading) return null;
  return glyph(projectIndicator(undefined, status ? [status] : [], loading));
}

/** Group-chip variant: one glyph rolled up across the group's member tabs. */
export function GroupActivityIndicator({ tabIds }: { tabIds: string[] }) {
  // The rolled-up glyph as one primitive from the store (W1-F): the chip renders only when the
  // glyph itself changes, not on each status event of each thread.
  return glyph(useTerminalsIndicator(tabIds));
}

function glyph(ind: ReturnType<typeof projectIndicator>) {
  if (ind === 'working') return <Spinner size={10} />;
  if (ind === 'needs_input' || ind === 'error') return <StatusDot state={ind} size={7} />;
  return null;
}
