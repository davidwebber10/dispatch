import { create } from 'zustand';
import { api } from '../api/client';
import type { UsageSummary } from '../api/types';
import type { ServerEvent } from '../api/events-socket';

/**
 * The usage gauge (#127): every provider's limit figures and every thread paused on a limit,
 * for the header chip, the paused banner and Settings > Usage limits. Loaded at boot and on a
 * reconnect (lib/resync.ts), then kept fresh by the daemon's throttled `usage-limits` event.
 * Null until the first load answers.
 */
interface UsageLimitsState {
  summary: UsageSummary | null;
  /**
   * The daemon instance that sent `summary` (core limits/gauge.ts), null when unknown or when an
   * older daemon sends none. A summary from a new epoch lands and resets `rev` to its own, so a
   * restarted daemon, even one whose clock went back, is never ignored. See acceptSummary.
   */
  epoch: string | null;
  /**
   * Epochs this store has moved past, newest last, at most RETIRED_MAX. A summary from one is
   * from a daemon that is gone, such as a GET that started before the restart and lands after.
   */
  retired: string[];
  /**
   * The floor: the newest revision seen in `epoch`. It never drops inside an epoch. An answer at
   * or below it is not newer than what is shown, so it is dropped. 0 until a revision lands.
   */
  rev: number;
  load: () => Promise<void>;
  /** The Refresh button (2026-11-09): read every account now. Resolves with `partial` when a read was still running; throws when the daemon could not be asked. */
  refresh: () => Promise<{ partial: boolean }>;
  applyEvent: (e: ServerEvent) => void;
}

interface Parsed { summary: UsageSummary; epoch: string | null; rev: number | null }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parse(e: Record<string, unknown>): Parsed | null {
  if (typeof e.warnPercent !== 'number' || !Array.isArray(e.providers) || !Array.isArray(e.paused)) return null;
  const epoch = typeof e.epoch === 'string' && e.epoch ? e.epoch : null;
  return {
    summary: {
      ...(typeof e.at === 'number' ? { at: e.at } : {}),
      warnPercent: e.warnPercent,
      ...(typeof e.pushOnWarn === 'boolean' ? { pushOnWarn: e.pushOnWarn } : {}),
      providers: e.providers as UsageSummary['providers'],
      paused: e.paused as UsageSummary['paused'],
    },
    epoch,
    // A 3.12 to 3.17 daemon sends only its build time `at`: that orders its summaries instead.
    rev: epoch === null ? num(e.at) : num(e.rev),
  };
}

const RETIRED_MAX = 8;

/** Where the store stands: the epoch it shows, the floor revision in it, and the epochs it moved past. */
export interface Position { epoch: string | null; rev: number; retired: string[] }

/**
 * The one rule for whether a summary lands, from a GET or a socket event alike. Returns the new
 * position, or null to drop it.
 * - An epoch in `retired` is a daemon that is gone: drop.
 * - No epoch while a real epoch is held: drop. A no-epoch summary lands only before any real one.
 * - The same epoch as held: land only when its rev is above the floor. A summary without a rev
 *   (a daemon that predates revisions) always lands. With no epoch, the rev is the daemon's `at`
 *   clock, and an equal one lands too, as it did before epochs.
 * - Any other real epoch, or one when none is held yet: a new daemon. Retire the held epoch, if
 *   any, adopt the new one with its rev as the floor, and land.
 */
export function acceptSummary(cur: Position, inc: { epoch: string | null; rev: number | null }): Position | null {
  if (inc.epoch !== null && cur.retired.includes(inc.epoch)) return null;
  // Once a real epoch is held, a summary without one is from a daemon that predates epochs, such as
  // a GET that was in flight across an upgrade. Drop it, and never let it retire the real epoch.
  if (inc.epoch === null && cur.epoch !== null) return null;
  if (inc.epoch === cur.epoch) {
    if (inc.rev === null) return cur;
    const newer = inc.epoch === null ? inc.rev >= cur.rev : inc.rev > cur.rev;
    return newer ? { ...cur, rev: inc.rev } : null;
  }
  const retired = cur.epoch === null ? cur.retired : [...cur.retired.filter((e) => e !== cur.epoch), cur.epoch].slice(-RETIRED_MAX);
  return { epoch: inc.epoch, rev: inc.rev ?? 0, retired };
}

export const useUsageLimits = create<UsageLimitsState>((set, get) => {
  /**
   * Bumped only when a load starts. A load's answer is dropped when a newer load started after it,
   * whatever its rev. The newer load will answer, and the older one may come from a daemon that
   * is gone: the boot GET reaches A, A restarts, the reconnect GET goes to B, and A answers first.
   * With no epoch held yet, nothing else would stop A landing, and B would then be dropped.
   */
  let loadSeq = 0;
  const take = (p: Parsed | null) => {
    if (!p) return;
    const { epoch, rev, retired } = get();
    const next = acceptSummary({ epoch, rev, retired }, p);
    if (next) set({ summary: p.summary, ...next });
  };
  return {
    summary: null,
    epoch: null,
    retired: [],
    rev: 0,
    load: async () => {
      const seq = ++loadSeq;
      // The epoch held when the GET went out. If a socket event moved the store to a new epoch
      // while it was in flight, an answer from any other epoch is from a daemon the store already
      // moved past, even one it never saw (the first GET reaching a daemon that then restarted).
      const heldAtStart = get().epoch;
      try {
        const answer = (await api.getUsageSummary()) as unknown as Record<string, unknown>;
        const p = parse(answer);
        if (!p) return;
        if (seq !== loadSeq) return; // a newer load started: its answer replaces this one
        const held = get().epoch;
        if (held !== heldAtStart && p.epoch !== held) return;
        take(p);
      } catch { /* an older daemon has no gauge, or the network dropped: keep what is there */ }
    },
    refresh: async () => {
      const answer = (await api.refreshUsage()) as unknown as Record<string, unknown>;
      ++loadSeq; // an older load in flight must not replace these figures
      take(parse(answer));
      return { partial: answer.partial === true };
    },
    applyEvent: (e) => {
      if (e.type !== 'usage-limits') return;
      take(parse(e));
    },
  };
});
