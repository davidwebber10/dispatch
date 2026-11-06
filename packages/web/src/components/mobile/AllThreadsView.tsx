import { useEffect, useMemo, useState } from 'react';
import { ChatsCircle } from '@phosphor-icons/react';
import type { Terminal } from '../../api/types';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { Spinner } from '../common/Spinner';
import { SwipeRow } from '../common/SwipeRow';
import { ThreadRow } from '../sidebar/ProjectCard';
import { ThreadMenu, type ThreadMenuAt } from '../sidebar/ThreadMenu';

const FILTER_KEY = 'dispatch:mobileThreadsProject';
const lastActive = (t: Terminal) => t.lastActivityAt ?? t.createdAt ?? '';

/**
 * The Threads view of the phone's Projects tab (2026-10-28, replaces the Pinned tab): every
 * thread of every project, newest activity first, with a project filter row and the search box
 * from the header. Pinning is gone: the few threads one works on are nearly always the latest
 * ones, and pinning and unpinning was a chore. Tabs for all projects are loaded on mount, as
 * the Pinned tab did, so threads surface for projects this client never opened.
 */
export function AllThreadsView({ onOpenThread, query = '' }: { onOpenThread: (projectId: string, tabId: string) => void; query?: string }) {
  const projects = useProjects((s) => s.sessions);
  const byProject = useTabs((s) => s.byProject);
  const [loading, setLoading] = useState(true);
  const [menu, setMenu] = useState<ThreadMenuAt | null>(null);
  const [filter, setFilter] = useState<string | null>(() => { try { return localStorage.getItem(FILTER_KEY); } catch { return null; } });
  useEffect(() => { try { if (filter) localStorage.setItem(FILTER_KEY, filter); else localStorage.removeItem(FILTER_KEY); } catch { /* ignore */ } }, [filter]);

  useEffect(() => {
    let alive = true;
    Promise.all(projects.map((p) => useTabs.getState().loadTabs(p.id).catch(() => { /* project gone */ })))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // Load once per mount; session:tabs-changed events keep the lists fresh after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nameOf = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  // A filter for a project that no longer exists falls back to All.
  const active = filter && nameOf.has(filter) ? filter : null;
  const q = query.trim().toLowerCase();
  const threads = useMemo(() => {
    const all: Terminal[] = [];
    for (const p of projects) for (const t of byProject[p.id] ?? []) if (t.type !== 'file' && !t.archivedAt) all.push(t);
    return all
      .filter((t) => !active || t.sessionId === active)
      .filter((t) => !q || t.label.toLowerCase().includes(q) || (nameOf.get(t.sessionId) ?? '').toLowerCase().includes(q))
      .sort((a, b) => (lastActive(a) < lastActive(b) ? 1 : lastActive(a) > lastActive(b) ? -1 : 0));
  }, [projects, byProject, active, q, nameOf]);
  const withThreads = projects.filter((p) => (byProject[p.id] ?? []).some((t) => t.type !== 'file' && !t.archivedAt));

  async function archive(t: Terminal) {
    try { await api.archiveTerminal(t.id); await useTabs.getState().loadTabs(t.sessionId); } catch { /* surfaced via connection state */ }
  }

  const chip = (on: boolean) => ({
    flex: '0 0 auto', height: 30, padding: '0 12px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--color-border)', cursor: 'pointer',
    background: on ? 'var(--color-accent)' : 'var(--color-elevated)', color: on ? '#08240F' : 'var(--color-text-secondary)',
    fontSize: 13, fontWeight: on ? 600 : 500, whiteSpace: 'nowrap' as const, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis',
  });

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div role="group" aria-label="Project filter" style={{ display: 'flex', gap: 6, padding: '8px 12px 6px', overflowX: 'auto', flexShrink: 0, scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
        <button type="button" aria-pressed={active === null} onClick={() => setFilter(null)} style={chip(active === null)}>All</button>
        {withThreads.map((p) => (
          <button key={p.id} type="button" aria-pressed={active === p.id} onClick={() => setFilter(p.id)} style={chip(active === p.id)}>{p.name}</button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', padding: '0 4px 12px' }}>
        {loading && !threads.length && <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={24} /></div>}
        {!loading && !threads.length && (
          <div style={{ padding: '48px 28px', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13.5, lineHeight: 1.6 }}>
            <ChatsCircle size={30} style={{ opacity: 0.5 }} />
            <div style={{ marginTop: 10 }}>{q || active ? 'No threads match.' : 'No threads yet.'}</div>
          </div>
        )}
        {threads.map((t) => (
          // Same row, ⋯ menu and swipe as a project's thread list. The swipe archives
          // straight away: it is undoable from the project's Archived section.
          <SwipeRow key={t.id} actionLabel="Archive" actionColor="var(--color-status-red)" onAction={() => void archive(t)}>
            <ThreadRow tab={t} active={false} subtitle={active ? undefined : nameOf.get(t.sessionId) ?? ''}
              onClick={() => onOpenThread(t.sessionId, t.id)}
              onMiddle={() => onOpenThread(t.sessionId, t.id)}
              onArchive={() => void archive(t)}
              onContext={(x, y) => setMenu({ tab: t, x, y })} />
          </SwipeRow>
        ))}
      </div>
      <ThreadMenu at={menu} onClose={() => setMenu(null)} onBranched={(b) => onOpenThread(b.sessionId, b.id)} />
    </div>
  );
}
