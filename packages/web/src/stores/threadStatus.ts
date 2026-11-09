import { create } from 'zustand';
import type { ServerEvent } from '../api/events-socket';
import { api } from '../api/client';

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
  /** The snapshot of the daemon's status authority (W3-C). Present only when the event carried it. */
  turnOpen?: boolean;
  /** The order of the snapshot: `generation` rises with each daemon start, `sequence` with each transition. */
  generation?: number;
  sequence?: number;
}

/** True when the event's snapshot is older than the one the entry holds: such an event is dropped. */
function isOlder(e: Record<string, unknown>, prev: ThreadStatus): boolean {
  if (typeof e.generation !== 'number' || typeof e.sequence !== 'number') return false; // no order: an older daemon
  if (typeof prev.generation !== 'number' || typeof prev.sequence !== 'number') return false;
  return e.generation < prev.generation || (e.generation === prev.generation && e.sequence < prev.sequence);
}

interface ThreadStatusState {
  byTerminal: Record<string, ThreadStatus>;
  /**
   * The stall watchdog's flags: terminal id to the time (epoch ms) since which a working thread
   * sent no output. Set and cleared by `terminal:stall` events; `loadStalls` reads the full list.
   * A flag is information only: the thread can still be at work.
   */
  stalls: Record<string, number>;
  applyEvent: (e: ServerEvent) => void;
  /** Drop the whole live overlay. Called on socket reconnect: while we were
   *  disconnected we missed every `terminal:status` broadcast, so an entry can be
   *  frozen at a stale `working` that outlived the real settle. Clearing lets the
   *  board fall back to the authoritative persisted rows until fresh events arrive. */
  reset: () => void;
  /** Replace `stalls` with the daemon's list (after a connect or a reconnect). A failed read keeps the old flags. */
  loadStalls: () => Promise<void>;
}

/** `obj` without `key`; the same object when the key is absent (no needless store update). */
function without<T>(obj: Record<string, T>, key: string): Record<string, T> {
  if (!(key in obj)) return obj;
  const next = { ...obj };
  delete next[key];
  return next;
}

let stallsRequested = false;
/** Read the stall flags once for this page load (the first StallBadge calls it). Reconnects go through `resyncAfterReconnect`. */
export function ensureStallsLoaded(): void {
  if (stallsRequested) return;
  stallsRequested = true;
  void useThreadStatus.getState().loadStalls();
}

export const useThreadStatus = create<ThreadStatusState>((set, get) => ({
  byTerminal: {},
  stalls: {},
  reset: () => set({ byTerminal: {} }),
  loadStalls: async () => {
    try {
      const list = await api.listStalls();
      const stalls: Record<string, number> = {};
      for (const s of list) if (typeof s?.terminalId === 'string' && typeof s.stalledSince === 'number') stalls[s.terminalId] = s.stalledSince;
      set({ stalls });
    } catch { /* offline or an older daemon: keep what the events gave */ }
  },
  applyEvent: (e) => {
    if (e.type === 'terminal:status' && typeof e.terminalId === 'string') {
      const prev = get().byTerminal[e.terminalId] ?? {};
      // W3-C: an event that is older than the one already applied (a lower generation, or a lower sequence
      // in the same generation) must not put a settled thread back to "working".
      if (isOlder(e as Record<string, unknown>, prev)) return;
      const ordered = typeof e.generation === 'number' && typeof e.sequence === 'number';
      const next: ThreadStatus = {
        status: typeof e.status === 'string' ? e.status : prev.status,
        threadStatus: typeof e.threadStatus === 'string' ? e.threadStatus : prev.threadStatus,
        // `activity` may be explicitly null (cleared on idle); only keep the
        // previous value when the field is entirely absent from the event.
        activity: 'activity' in e ? (e.activity as string | null) : prev.activity,
        ...(typeof e.turnOpen === 'boolean' ? { turnOpen: e.turnOpen } : 'turnOpen' in prev ? { turnOpen: prev.turnOpen } : {}),
        ...(ordered ? { generation: e.generation as number, sequence: e.sequence as number }
          : 'sequence' in prev ? { generation: prev.generation, sequence: prev.sequence } : {}),
      };
      // A thread that left "working" is not stalled: do not wait for the daemon's next 30 s tick to say so.
      const stalls = next.status !== 'working' ? without(get().stalls, e.terminalId) : get().stalls;
      set({ byTerminal: { ...get().byTerminal, [e.terminalId]: next }, stalls });
    } else if (e.type === 'terminal:exit' && typeof e.terminalId === 'string') {
      const prev = get().byTerminal[e.terminalId] ?? {};
      set({ byTerminal: { ...get().byTerminal, [e.terminalId]: { ...prev, status: 'waiting', threadStatus: 'idle', activity: null } }, stalls: without(get().stalls, e.terminalId) });
    } else if (e.type === 'terminal:stall' && typeof e.terminalId === 'string') {
      if (e.stalledSince === null) return set({ stalls: without(get().stalls, e.terminalId) });
      const since = typeof e.stalledSince === 'string' ? Date.parse(e.stalledSince) : NaN;
      if (Number.isFinite(since)) set({ stalls: { ...get().stalls, [e.terminalId]: since } });
    }
  },
}));
