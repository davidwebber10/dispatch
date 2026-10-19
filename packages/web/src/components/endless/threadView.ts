import { useEndless } from '../../stores/endless';
import { useThreadStatus } from '../../stores/threadStatus';
import type { EndlessPaneState, EndlessPaneThread } from '../../api/types';

/** The live overlay (terminal:status) is newer than the pane row, so it wins when present.
 * The live threadStatus is not needed by the current mapping; the parameter keeps the signature. */
export function stateFromStatus(status: string | undefined, _threadStatus: string | undefined, fallback: EndlessPaneState | null): EndlessPaneState | null {
  switch (status) {
    case 'working': return 'working';
    case 'needs_input': return 'needs_you';
    case 'queued': return 'queued';
    case 'error': return 'error';
    case 'waiting': return fallback === 'idle' ? 'idle' : 'done'; // an owner thread stays idle; a worker is done
    default: return fallback;
  }
}

export function useThreadView(id: string | null): { row: EndlessPaneThread | null; state: EndlessPaneState | null; activity: string | null } {
  const row = useEndless((s) => (id ? s.threads.find((t) => t.id === id) ?? null : null));
  const live = useThreadStatus((s) => (id ? s.byTerminal[id] : undefined));
  return { row, state: stateFromStatus(live?.status, live?.threadStatus, row?.state ?? null), activity: live?.activity ?? null };
}
