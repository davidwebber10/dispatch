import type { Terminal } from '../api/types';
import type { ThreadStatus } from '../stores/threadStatus';

/**
 * The attention queue (engineering program 2026-11-09, W2-F): the threads that wait for the owner,
 * across every project. It feeds a list and a filter in the navigation (the sidebar's "Needs you"
 * section, the Threads list's Status filter, the palette row and Alt+N). It is never a strip or a
 * pop-up inside a thread, and a row has no Answer button: a row opens the thread, and the question
 * stays where the thread put it (lib/noAskStrip.test.ts).
 */
export type AttentionReason = 'needs_input' | 'error' | 'stalled';
export interface AttentionItem { terminalId: string; projectId: string; label: string; reason: AttentionReason; since: number }
/** The live status overlay, by terminal id (stores/threadStatus.ts `byTerminal`). */
export type ThreadStatusMap = Record<string, ThreadStatus>;

const RANK: Record<AttentionReason, number> = { needs_input: 0, error: 1, stalled: 2 };
/** A tab that is not a thread: a file, a browser, notes. */
const NOT_A_THREAD = new Set<string>(['file', 'browser', 'notes']);

/** A thread the queue and the status filter can name: not archived, not a file or browser tab, not the coordinator. */
export function isAttentionThread(t: Terminal): boolean {
  return !t.archivedAt && !NOT_A_THREAD.has(t.type) && t.config?.role !== 'coordinator';
}

/** The status the queue reads: the live event when there is one, else the stored row. */
export function liveStatus(t: Terminal, status: ThreadStatusMap): string {
  return status[t.id]?.status ?? t.status;
}

/** Why a thread waits for the owner, or null. A stall flag counts only while the thread works. */
export function attentionReason(t: Terminal, status: ThreadStatusMap, stalls: Record<string, number>): AttentionReason | null {
  const s = liveStatus(t, status);
  if (s === 'needs_input') return 'needs_input';
  if (s === 'error') return 'error';
  if (s === 'working' && typeof stalls[t.id] === 'number') return 'stalled';
  return null;
}

/** Needs input, then error, then stalled; inside a group the thread that has waited longest is first. */
export function attentionList(input: { byProject: Record<string, Terminal[]>; status: ThreadStatusMap; stalls: Record<string, number> }): AttentionItem[] {
  const { byProject, status, stalls } = input;
  const out: AttentionItem[] = [];
  for (const list of Object.values(byProject)) {
    for (const t of list) {
      if (!isAttentionThread(t)) continue;
      const reason = attentionReason(t, status, stalls);
      if (!reason) continue;
      const since = reason === 'stalled' ? stalls[t.id] : Date.parse(t.lastActivityAt ?? t.createdAt) || 0;
      out.push({ terminalId: t.id, projectId: t.sessionId, label: t.label, reason, since });
    }
  }
  return out.sort((a, b) => RANK[a.reason] - RANK[b.reason] || a.since - b.since || a.terminalId.localeCompare(b.terminalId));
}

/**
 * The item "next" goes to: the one after the open thread, back to the first after the last. When the
 * open thread is not in the list it is the first item. Null when no OTHER thread waits.
 */
export function nextAttention(items: AttentionItem[], currentId: string | null): AttentionItem | null {
  if (!items.length) return null;
  const i = currentId ? items.findIndex((x) => x.terminalId === currentId) : -1;
  if (i < 0) return items[0];
  const next = items[(i + 1) % items.length];
  return next.terminalId === currentId ? null : next;
}
