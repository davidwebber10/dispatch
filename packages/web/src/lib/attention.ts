import { useEffect, useMemo } from 'react';
import type { Terminal } from '../api/types';
import { ensureStallsLoaded, useThreadStatus, type ThreadStatus } from '../stores/threadStatus';
import { useTabs } from '../stores/tabs';
import { useProjects } from '../stores/projects';
import { useNavigation } from '../stores/navigation';
import { useHint } from '../stores/hint';

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

// ── The live queue ───────────────────────────────────────────────────────────────────────────

/** The queue from the stores, now. */
export function currentAttention(): AttentionItem[] {
  const { byTerminal, stalls } = useThreadStatus.getState();
  return attentionList({ byProject: useTabs.getState().byProject, status: byTerminal, stalls });
}

/** Projects whose thread list was read for the queue on this page load. */
const refreshed = new Set<string>();
/**
 * The queue spans every project, but a project's threads load when the project opens. So read the
 * thread list of each project that can hold an item: one whose status is not at rest, or whose list
 * from the last visit (the launch snapshot) names a thread that waits. Once per project per page
 * load; after that the status events keep the lists right. Runs when the project list changes (a
 * `session:status` event), so it needs no timer.
 */
function loadAttentionSources(): void {
  const tabs = useTabs.getState();
  const { byTerminal, stalls } = useThreadStatus.getState();
  for (const s of useProjects.getState().sessions) {
    if (refreshed.has(s.id)) continue;
    const list = tabs.byProject[s.id];
    const atRest = s.status === 'waiting' || s.status === 'done' || (s.status as string) === 'idle';
    const waits = !!list?.some((t) => isAttentionThread(t) && attentionReason(t, byTerminal, stalls));
    if (atRest && !waits) continue;
    refreshed.add(s.id);
    void tabs.loadTabs(s.id).catch(() => { refreshed.delete(s.id); });
  }
}

/** The queue, live. The component that calls it renders on each status event; keep it small. */
export function useAttention(): AttentionItem[] {
  const byProject = useTabs((s) => s.byProject);
  const status = useThreadStatus((s) => s.byTerminal);
  const stalls = useThreadStatus((s) => s.stalls);
  const sessions = useProjects((s) => s.sessions);
  useEffect(() => { ensureStallsLoaded(); }, []);
  useEffect(() => { loadAttentionSources(); }, [sessions]);
  return useMemo(() => attentionList({ byProject, status, stalls }), [byProject, status, stalls]);
}

/**
 * "Next thread that needs you" (Alt+N, and the palette row): opens the next item of the queue.
 * The open thread is the one in the address. Returns false, with a hint, when no other thread waits.
 */
export function openNextAttention(): boolean {
  loadAttentionSources();
  const route = useNavigation.getState().route;
  const open = route.view === 'workspace' ? route.threadId ?? null : null;
  const items = currentAttention();
  const next = nextAttention(items, open);
  if (!next) {
    useHint.getState().show(items.length ? 'No other thread needs you.' : 'No thread needs you.');
    return false;
  }
  useNavigation.getState().navigate({ view: 'workspace', projectId: next.projectId, threadId: next.terminalId });
  return true;
}

/**
 * Alt+N: go to the next thread that needs you. Checked for a clash on 2026-11-09: no other handler
 * in the app reads Alt+N (the palette is Cmd/Ctrl+K, the tab cycle Ctrl+Tab), and no browser binds
 * it. The match is on the physical key (`code`), because Option+N on a Mac is a dead key ("˜") and
 * `key` is then "Dead". Inside a terminal the key belongs to the shell (Meta-n), as with the palette.
 */
export function useAttentionShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyN' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (document.activeElement?.closest?.('.xterm')) return;
      e.preventDefault();
      openNextAttention();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Test only: forget which projects were read for the queue. */
export function __resetAttentionForTest(): void { refreshed.clear(); }
