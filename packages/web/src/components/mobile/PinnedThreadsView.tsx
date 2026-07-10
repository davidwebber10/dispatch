import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaretRight, ChatCircle, TerminalWindow, PushPin } from '@phosphor-icons/react';
import type { Terminal } from '../../api/types';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { providerColor } from '../common/typeIcons';
import { StatusDot } from '../common/StatusDot';
import { Spinner } from '../common/Spinner';
import { SwipeRow } from '../common/SwipeRow';
import { timeAgo } from '../../lib/time';

const isPinned = (t: Terminal) => (t.config as { pinned?: boolean })?.pinned === true;

/**
 * Cross-project "Pinned" tab (mobile root): every thread pinned via the thread
 * options menu, grouped by project. Pins live in the terminal's `config.pinned`
 * on the server, so they follow you across devices. Tabs for all projects are
 * (re)loaded on mount — pinned threads must surface even for projects whose
 * lists this client never opened.
 */
export function PinnedThreadsView({ onOpenThread }: { onOpenThread: (projectId: string, tabId: string) => void }) {
  const projects = useProjects((s) => s.sessions);
  const byProject = useTabs((s) => s.byProject);
  const loadingMap = useTabs((s) => s.loading);
  const [loading, setLoading] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<{ tab: Terminal; x: number; y: number } | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all(projects.map((p) => useTabs.getState().loadTabs(p.id).catch(() => { /* project gone */ })))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // Load once per mount — the tab list refreshes via session:tabs-changed events after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = projects
    .map((p) => ({ project: p, threads: (byProject[p.id] ?? []).filter(isPinned) }))
    .filter((g) => g.threads.length > 0);

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', padding: '0 4px 12px' }}>
      {loading && !groups.length && <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={24} /></div>}
      {!loading && !groups.length && (
        <div style={{ padding: '48px 28px', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13.5, lineHeight: 1.6 }}>
          <PushPin size={30} style={{ opacity: 0.5 }} />
          <div style={{ marginTop: 10 }}>No pinned threads yet.</div>
          <div>Open a thread's ⋯ menu and choose “Pin thread”.</div>
        </div>
      )}
      {groups.map(({ project, threads }) => (
        <div key={project.id} style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '12px 12px 6px' }}>
            <span style={{ font: '700 13px var(--font-mono)', letterSpacing: '1.1px', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name.toUpperCase()}</span>
          </div>
          {threads.map((t) => {
            const color = providerColor(t.type);
            const structuredClaude = t.type === 'claude-code' && (t.config as { transport?: string })?.transport === 'structured';
            const working = loadingMap[t.id] || t.status === 'working';
            const needsAttn = t.status === 'needs_input' || t.status === 'error';
            return (
              <SwipeRow key={t.id} actionLabel="Unpin" actionColor="#3F3F46" onAction={() => void useTabs.getState().setPinned(t.id, false)}>
                <button onClick={() => onOpenThread(project.id, t.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '15px 12px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--color-border)', cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }}>
                  <span style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {structuredClaude
                      ? <ChatCircle size={17} weight="fill" color={color} />
                      : <TerminalWindow size={17} weight="fill" color={color} />}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 16, fontWeight: 450, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label}</span>
                  <span role="button" title="Thread options" aria-label="Thread options"
                    onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setCtxMenu({ tab: t, x: r.left, y: r.bottom }); }}
                    style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: 'var(--color-text-secondary)', fontSize: 18, lineHeight: 1 }}>⋯</span>
                  {working
                    ? <Spinner size={13} />
                    : needsAttn
                      ? <StatusDot state={t.status === 'error' ? 'error' : 'needs_input'} size={9} />
                      : <span style={{ flexShrink: 0, font: '400 12px var(--font-mono)', color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{timeAgo(t.lastActivityAt ?? t.createdAt)}</span>}
                  <CaretRight size={16} color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />
                </button>
              </SwipeRow>
            );
          })}
        </div>
      ))}

      {ctxMenu && createPortal(
        <>
          <div onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }} style={{ position: 'fixed', inset: 0, zIndex: 300 }} />
          <div style={{ position: 'fixed', top: ctxMenu.y, left: Math.min(ctxMenu.x, window.innerWidth - 184), zIndex: 301, minWidth: 168, background: '#1B1B1E', border: '1px solid #2C2C32', borderRadius: 9, padding: 4, boxShadow: '0 20px 50px -20px rgba(0,0,0,.8)' }}>
            <button onClick={() => { void useTabs.getState().setPinned(ctxMenu.tab.id, false); setCtxMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13 }}>Unpin thread</button>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
