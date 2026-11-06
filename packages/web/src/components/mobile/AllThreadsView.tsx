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
import { ArchivedThreadsList } from './ArchivedThreadsList';
import { isAgentStarted, startedByOf, startedByText } from '../../lib/startedBy';

const FILTER_KEY = 'dispatch:mobileThreadsProject';
const STARTER_KEY = 'dispatch:mobileThreadsStarter';
type Starter = 'mine' | 'agents' | 'all';
const STARTERS: { id: Starter; label: string }[] = [{ id: 'mine', label: 'Mine' }, { id: 'agents', label: 'Agents' }, { id: 'all', label: 'All' }];
const readStarter = (): Starter => { try { const v = localStorage.getItem(STARTER_KEY); return v === 'agents' || v === 'all' ? v : 'mine'; } catch { return 'mine'; } };
const lastActive = (t: Terminal) => t.lastActivityAt ?? t.createdAt ?? '';

/**
 * The Threads view of the phone's Projects tab (2026-10-28, replaces the Pinned tab): every
 * thread of every project, newest activity first, with a project filter row and the search box
 * from the header. Pinning is gone: the few threads one works on are nearly always the latest
 * ones, and pinning and unpinning was a chore. Tabs for all projects are loaded on mount, as
 * the Pinned tab did, so threads surface for projects this client never opened.
 *
 * Mine · Agents · All (2026-11-05): most rows were started by an agent (Chat, an overseer, another
 * thread, a scheduled role), which buried the owner's own threads. The split comes from the
 * thread's config alone (lib/startedBy.ts). It opens on Mine and is remembered per device.
 */
export function AllThreadsView({ onOpenThread, query = '' }: { onOpenThread: (projectId: string, tabId: string) => void; query?: string }) {
  const projects = useProjects((s) => s.sessions);
  const byProject = useTabs((s) => s.byProject);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [menu, setMenu] = useState<ThreadMenuAt | null>(null);
  const [filter, setFilter] = useState<string | null>(() => { try { return localStorage.getItem(FILTER_KEY); } catch { return null; } });
  const [chosenStarter, setStarter] = useState<Starter>(readStarter);
  useEffect(() => { try { localStorage.setItem(STARTER_KEY, chosenStarter); } catch { /* ignore */ } }, [chosenStarter]);
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
  const isMine = (t: Terminal) => !isAgentStarted(t.config);
  // Mine · Agents · All is only worth showing when an agent started something (2026-11-06). Counted
  // over every active thread, not the search or project, so it doesn't come and go while typing.
  // Hidden, the list is everything; the saved choice comes back with the first agent thread.
  const anyAgents = useMemo(
    () => projects.some((p) => (byProject[p.id] ?? []).some((t) => t.type !== 'file' && !t.archivedAt && isAgentStarted(t.config))),
    [projects, byProject],
  );
  const starter: Starter = anyAgents ? chosenStarter : 'all';
  // Rows in the chosen project that match the search: the base for the counts and the list.
  const matching = useMemo(() => {
    const all: Terminal[] = [];
    for (const p of projects) for (const t of byProject[p.id] ?? []) if (t.type !== 'file' && !t.archivedAt) all.push(t);
    return all
      .filter((t) => !active || t.sessionId === active)
      .filter((t) => !q || t.label.toLowerCase().includes(q) || (nameOf.get(t.sessionId) ?? '').toLowerCase().includes(q))
      .sort((a, b) => (lastActive(a) < lastActive(b) ? 1 : lastActive(a) > lastActive(b) ? -1 : 0));
  }, [projects, byProject, active, q, nameOf]);
  const nMine = matching.filter(isMine).length;
  const counts: Record<Starter, number> = { mine: nMine, agents: matching.length - nMine, all: matching.length };
  const threads = starter === 'all' ? matching : matching.filter((t) => isMine(t) === (starter === 'mine'));
  // Chips list the projects that have a thread in the chosen filter (the pressed one always stays).
  const inFilter = (t: Terminal) => t.type !== 'file' && !t.archivedAt && (starter === 'all' || isMine(t) === (starter === 'mine'));
  const withThreads = projects.filter((p) => p.id === active || (byProject[p.id] ?? []).some(inFilter));
  const otherFilter: Starter | null = starter === 'mine' ? 'agents' : starter === 'agents' ? 'mine' : null;
  const otherCount = otherFilter ? counts[otherFilter] : 0;
  const findParent = (sessionId: string) => (id: string) => (byProject[sessionId] ?? []).find((x) => x.id === id) ?? null;
  const startedText = (t: Terminal) => startedByText(startedByOf(t, findParent(t.sessionId)));

  async function archive(t: Terminal) {
    try { await api.archiveTerminal(t.id); await useTabs.getState().loadTabs(t.sessionId); } catch { /* surfaced via connection state */ }
  }

  const chip = (on: boolean) => ({
    flex: '0 0 auto', height: 30, padding: '0 12px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--color-border)', cursor: 'pointer',
    background: on ? 'var(--color-accent)' : 'var(--color-elevated)', color: on ? '#08240F' : 'var(--color-text-secondary)',
    fontSize: 13, fontWeight: on ? 600 : 500, whiteSpace: 'nowrap' as const, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis',
  });

  const seg = (on: boolean): React.CSSProperties => ({
    flex: 1, height: 28, border: 'none', cursor: 'pointer', borderRadius: 'var(--radius-pill)', whiteSpace: 'nowrap',
    background: on ? 'var(--color-accent)' : 'transparent', color: on ? '#08240F' : 'var(--color-text-secondary)', fontSize: 12.5, fontWeight: on ? 600 : 500,
  });

  // Active ⇄ Archived (2026-11-05): archived threads were only reachable inside each project.
  const tabBtn = (on: boolean): React.CSSProperties => ({
    padding: '8px 2px 7px', background: 'transparent', border: 'none', cursor: 'pointer', marginBottom: -1,
    borderBottom: on ? '2px solid var(--color-accent)' : '2px solid transparent',
    color: on ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)', font: '700 12.5px var(--font-mono)', letterSpacing: '1px',
  });
  const chipProjects = tab === 'archived' ? projects : withThreads;
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div role="tablist" aria-label="Thread list" style={{ display: 'flex', gap: 18, padding: '2px 14px 0', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
        <button type="button" role="tab" aria-selected={tab === 'active'} onClick={() => setTab('active')} style={tabBtn(tab === 'active')}>ACTIVE</button>
        <button type="button" role="tab" aria-selected={tab === 'archived'} onClick={() => setTab('archived')} style={tabBtn(tab === 'archived')}>ARCHIVED</button>
      </div>
      {tab === 'active' && anyAgents && (
        <div role="radiogroup" aria-label="Started by" style={{ display: 'flex', gap: 2, margin: '8px 12px 0', padding: 2, flexShrink: 0, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-pill)', background: 'var(--color-elevated)' }}>
          {STARTERS.map((o) => (
            <button key={o.id} type="button" role="radio" aria-checked={starter === o.id} onClick={() => setStarter(o.id)} style={seg(starter === o.id)}>
              {o.label} <span style={{ opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}>{counts[o.id]}</span>
            </button>
          ))}
        </div>
      )}
      <div role="group" aria-label="Project filter" style={{ display: 'flex', gap: 6, padding: '8px 12px 6px', overflowX: 'auto', flexShrink: 0, scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
        <button type="button" aria-pressed={active === null} onClick={() => setFilter(null)} style={chip(active === null)}>All</button>
        {chipProjects.map((p) => (
          <button key={p.id} type="button" aria-pressed={active === p.id} onClick={() => setFilter(p.id)} style={chip(active === p.id)}>{p.name}</button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', padding: '0 4px 12px' }}>
        {tab === 'archived' ? <ArchivedThreadsList project={active} query={query} onOpenThread={onOpenThread} /> : <>
        {loading && !threads.length && <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={24} /></div>}
        {!loading && !threads.length && (
          <div style={{ padding: '48px 28px', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13.5, lineHeight: 1.6 }}>
            <ChatsCircle size={30} style={{ opacity: 0.5 }} />
            <div style={{ marginTop: 10 }}>{q || active || otherCount ? 'No threads match.' : 'No threads yet.'}</div>
            {otherFilter && otherCount > 0 && (
              <button type="button" onClick={() => setStarter(otherFilter)} style={{ ...chip(false), marginTop: 12, height: 34, maxWidth: 'none' }}>
                {otherFilter === 'agents' ? `Show ${otherCount} agent ${otherCount === 1 ? 'thread' : 'threads'}` : `Show ${otherCount} of my threads`}
              </button>
            )}
          </div>
        )}
        {threads.map((t) => (
          // Same row, ⋯ menu and swipe as a project's thread list. The swipe archives
          // straight away: it is undoable from the project's Archived section.
          <SwipeRow key={t.id} actionLabel="Archive" actionColor="var(--color-status-red)" onAction={() => void archive(t)}>
            <ThreadRow tab={t} active={false} subtitle={[active ? '' : nameOf.get(t.sessionId) ?? '', startedText(t)].filter(Boolean).join(' · ') || undefined}
              onClick={() => onOpenThread(t.sessionId, t.id)}
              onMiddle={() => onOpenThread(t.sessionId, t.id)}
              onArchive={() => void archive(t)}
              onContext={(x, y) => setMenu({ tab: t, x, y })} />
          </SwipeRow>
        ))}
        </>}
      </div>
      <ThreadMenu at={menu} onClose={() => setMenu(null)} onBranched={(b) => onOpenThread(b.sessionId, b.id)} />
    </div>
  );
}
