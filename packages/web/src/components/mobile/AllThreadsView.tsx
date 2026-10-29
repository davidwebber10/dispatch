import { useEffect, useMemo, useState } from 'react';
import { CaretRight, ChatCircle, TerminalWindow, ChatsCircle } from '@phosphor-icons/react';
import type { Terminal } from '../../api/types';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { providerColor } from '../common/typeIcons';
import { StatusDot } from '../common/StatusDot';
import { Spinner } from '../common/Spinner';
import { timeAgo } from '../../lib/time';

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
  const loadingMap = useTabs((s) => s.loading);
  const [loading, setLoading] = useState(true);
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

  const chip = (on: boolean) => ({
    flex: '0 0 auto', height: 30, padding: '0 12px', borderRadius: 999, border: '1px solid var(--color-border)', cursor: 'pointer',
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
        {threads.map((t) => {
          const color = providerColor(t.type);
          const structuredClaude = t.type === 'claude-code' && (t.config as { transport?: string })?.transport === 'structured';
          const working = loadingMap[t.id] || t.status === 'working';
          const needsAttn = t.status === 'needs_input' || t.status === 'error';
          return (
            <button key={t.id} onClick={() => onOpenThread(t.sessionId, t.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '13px 12px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--color-border)', cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }}>
              <span style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {structuredClaude ? <ChatCircle size={17} weight="fill" color={color} /> : <TerminalWindow size={17} weight="fill" color={color} />}
              </span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span data-testid="thread-label" style={{ fontSize: 16, fontWeight: 450, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</span>
                {!active && <span style={{ font: '400 11.5px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf.get(t.sessionId) ?? ''}</span>}
              </span>
              {working
                ? <Spinner size={13} />
                : needsAttn
                  ? <StatusDot state={t.status === 'error' ? 'error' : 'needs_input'} size={9} />
                  : <span style={{ flexShrink: 0, font: '400 12px var(--font-mono)', color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{timeAgo(lastActive(t))}</span>}
              <CaretRight size={16} color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
