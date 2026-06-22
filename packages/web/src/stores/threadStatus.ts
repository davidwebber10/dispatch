import { create } from 'zustand';
import type { ServerEvent } from '../api/events-socket';

/**
 * Live per-terminal status + activity, driven by `terminal:status` events.
 *
 * The StatusService broadcasts the rich shape (coarse `status`, normalized
 * `threadStatus`, and a human `activity` label). Other sources (Codex pty-timing,
 * exit/relaunch) broadcast only `status` — so we merge, keeping the previous
 * `threadStatus`/`activity` when an event doesn't carry them.
 */
export interface ThreadStatus {
  /** Coarse persisted enum: working | needs_input | waiting | error. */
  status?: string;
  /** Rich normalized status: starting | working | needs_input | idle | done | error. */
  threadStatus?: string;
  /** Human activity label, e.g. "Running: npm test" or "Editing app.ts". */
  activity?: string | null;
}

interface ThreadStatusState {
  byTerminal: Record<string, ThreadStatus>;
  applyEvent: (e: ServerEvent) => void;
}

export const useThreadStatus = create<ThreadStatusState>((set, get) => ({
  byTerminal: {},
  applyEvent: (e) => {
    if (e.type === 'terminal:status' && typeof e.terminalId === 'string') {
      const prev = get().byTerminal[e.terminalId] ?? {};
      const next: ThreadStatus = {
        status: typeof e.status === 'string' ? e.status : prev.status,
        threadStatus: typeof e.threadStatus === 'string' ? e.threadStatus : prev.threadStatus,
        // `activity` may be explicitly null (cleared on idle); only keep the
        // previous value when the field is entirely absent from the event.
        activity: 'activity' in e ? (e.activity as string | null) : prev.activity,
      };
      set({ byTerminal: { ...get().byTerminal, [e.terminalId]: next } });
    } else if (e.type === 'terminal:exit' && typeof e.terminalId === 'string') {
      const prev = get().byTerminal[e.terminalId] ?? {};
      set({ byTerminal: { ...get().byTerminal, [e.terminalId]: { ...prev, status: 'waiting', threadStatus: 'idle', activity: null } } });
    }
  },
}));
