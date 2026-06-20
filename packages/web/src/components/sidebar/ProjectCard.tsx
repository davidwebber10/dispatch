import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, CaretRight } from '@phosphor-icons/react';
import type { Session, Terminal, AgentSchedule } from '../../api/types';
import { useTabs } from '../../stores/tabs';
import { useProjects } from '../../stores/projects';
import { useAgents } from '../../stores/agents';
import { useAgentUI } from '../../stores/agentUI';
import { StatusDot } from '../common/StatusDot';
import { Spinner } from '../common/Spinner';
import { ConfirmModal } from '../common/ConfirmModal';
import { providerColor } from '../common/typeIcons';
import { useSettings } from '../../stores/settings';
import { useIsMobile } from '../../hooks/useIsMobile';
import { timeAgo } from '../../lib/time';
import { NewTabMenu } from './NewTabMenu';
import { RenameThreadModal } from './RenameThreadModal';
import { api } from '../../api/client';

function dotState(status: string): 'working' | 'idle' | 'needs_input' {
  if (status === 'working') return 'working';
  if (status === 'needs_input') return 'needs_input';
  return 'idle';
}

const SECTIONS: { key: string; label: string; types: Terminal['type'][]; add: 'menu' | 'browser' | 'notes' | null; prominent?: boolean }[] = [
  { key: 'threads', label: 'THREADS', types: ['claude-code', 'codex', 'shell'], add: 'menu', prominent: true },
  { key: 'web', label: 'WEB', types: ['browser'], add: 'browser' },
  { key: 'notes', label: 'NOTES', types: ['notes'], add: 'notes' },
  { key: 'files', label: 'FILES', types: ['file'], add: null },
];

const plusBtn: React.CSSProperties = { width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', font: '600 14px/1 var(--font-sans)', borderRadius: 4 };

function homePath(p: string): string {
  return (p || '').replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function ThreadRow({ tab, active, onClick, onMiddle, onArchive, onContext }: { tab: Terminal; active: boolean; onClick: (e: React.MouseEvent) => void; onMiddle: () => void; onArchive: () => void; onContext: (x: number, y: number) => void }) {
  const [hover, setHover] = useState(false);
  const color = providerColor(tab.type);
  const loading = useTabs((s) => !!s.loading[tab.id]);
  const fs = useSettings((s) => s.sidebarFontSize);
  const isMobile = useIsMobile();
  const dot = isMobile ? 11 : 8;
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onMiddle(); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext(e.clientX, e.clientY); }}
      style={{
        display: 'flex', alignItems: 'center', gap: isMobile ? 12 : 9, width: '100%', padding: isMobile ? '15px 12px' : '7px 9px',
        background: active ? 'var(--color-hover)' : hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        borderRadius: isMobile ? 0 : 6, border: 'none', borderBottom: isMobile ? '1px solid var(--color-border)' : 'none',
        color: active ? '#fff' : 'var(--color-text-primary)', fontSize: isMobile ? 16 : fs, fontWeight: active ? 500 : isMobile ? 450 : 400,
        textAlign: 'left', cursor: 'pointer',
      }}
    >
      <span style={{ width: dot, height: dot, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.label}</span>
      <span style={{ flexShrink: 0, font: `400 ${isMobile ? 12 : 10.5}px var(--font-mono)`, color: 'var(--color-text-tertiary)' }}>{timeAgo(tab.createdAt)}</span>
      <span style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {hover && !isMobile ? (
          <span role="button" title="Archive thread" onClick={(e) => { e.stopPropagation(); onArchive(); }}
            style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, color: 'var(--color-text-secondary)', fontSize: 14, lineHeight: 1, cursor: 'pointer' }}>×</span>
        ) : (loading || tab.status === 'working') ? (
          <Spinner size={isMobile ? 13 : 11} />
        ) : (
          <StatusDot state={dotState(tab.status)} size={isMobile ? 9 : 7} />
        )}
      </span>
    </button>
  );
}

function AgentRow({ agent, active, onClick }: { agent: AgentSchedule; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const fs = useSettings((s) => s.sidebarFontSize);
  const isMobile = useIsMobile();
  const dot = isMobile ? 11 : 8;
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        display: 'flex', alignItems: 'center', gap: isMobile ? 12 : 9, width: '100%', padding: isMobile ? '15px 12px' : '7px 9px',
        background: active ? 'var(--color-hover)' : hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        borderRadius: isMobile ? 0 : 6, border: 'none', borderBottom: isMobile ? '1px solid var(--color-border)' : 'none',
        color: active ? '#fff' : 'var(--color-text-primary)', fontSize: isMobile ? 16 : fs,
        fontWeight: active ? 500 : isMobile ? 450 : 400, textAlign: 'left', cursor: 'pointer', opacity: agent.enabled ? 1 : 0.55,
      }}
    >
      <span style={{ width: dot, height: dot, borderRadius: '50%', background: providerColor(agent.provider), flexShrink: 0 }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.name}</span>
      <span style={{ flexShrink: 0, font: `400 ${isMobile ? 12 : 10.5}px var(--font-mono)`, color: 'var(--color-text-tertiary)' }}>{timeAgo(agent.createdAt)}</span>
      <span style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <StatusDot state={agent.enabled ? 'idle' : 'disabled'} size={isMobile ? 9 : 7} />
      </span>
    </button>
  );
}

function SectionHeader({ label, count, prominent, children }: { label: string; count: number; prominent?: boolean; children?: React.ReactNode }) {
  const isMobile = useIsMobile();
  // On mobile all section labels share one bigger, brighter style so FILES
  // matches THREADS / AGENTS; on desktop the prominent/quiet tiers are kept.
  const labelStyle: React.CSSProperties = isMobile
    ? { font: '700 13px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-secondary)' }
    : prominent
      ? { font: '700 11px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-secondary)' }
      : { font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: isMobile ? '12px 12px 6px' : (prominent ? '4px 6px 3px' : '2px 6px') }}>
      <span style={labelStyle}>{label}</span>
      {prominent && count > 0 && (
        <span style={{ font: `600 ${isMobile ? 11 : 9.5}px var(--font-mono)`, color: 'var(--color-text-secondary)', background: 'var(--color-elevated)', borderRadius: 9, padding: '0 6px', lineHeight: isMobile ? '17px' : '15px' }}>{count}</span>
      )}
      <span style={{ flex: 1 }} />
      {children}
    </div>
  );
}

export function ProjectCard({ session, active, onSelectTab, onSelectAgent, onNewAgent, onBrowseFiles }: { session: Session; active: boolean; onSelectTab: (id: string) => void; onSelectAgent?: (id: string) => void; onNewAgent?: (projectId: string) => void; onBrowseFiles?: (projectId: string) => void }) {
  const allAgents = useAgents((s) => s.schedules);
  const agents = allAgents.filter((a) => a.projectId === session.id);
  const agentSel = useAgents((s) => s.selectedId);
  const agentFocused = useAgentUI((s) => s.focused);
  const tabs = useTabs((s) => s.byProject[session.id]) ?? [];
  const activeTabId = useTabs((s) => s.activeTabId);
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<Terminal | null>(null);
  const [renameTarget, setRenameTarget] = useState<Terminal | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ tab: Terminal; x: number; y: number } | null>(null);
  const [projMenu, setProjMenu] = useState<{ x: number; y: number } | null>(null);
  const [projArchive, setProjArchive] = useState(false);
  const loadingMap = useTabs((s) => s.loading);
  const pfs = useSettings((s) => s.projectFontSize);
  const isMobile = useIsMobile();
  const plusStyle: React.CSSProperties = isMobile ? { ...plusBtn, width: 34, height: 34, font: '500 26px/1 var(--font-sans)', borderRadius: 9 } : plusBtn;
  const working = session.status === 'working' || tabs.some((t) => t.status === 'working' || loadingMap[t.id]);
  useEffect(() => { if (active) void useTabs.getState().loadTabs(session.id); }, [active, session.id]);

  async function addTab(type: string, config?: Record<string, unknown>) {
    const t = await api.createTerminal(session.id, { type, ...(config ? { config } : {}) });
    await useTabs.getState().loadTabs(session.id);
    useTabs.getState().markLoading(t.id);
    onSelectTab(t.id);
  }

  async function archive(tab: Terminal) {
    setArchiveTarget(null);
    try { await api.archiveTerminal(tab.id); await useTabs.getState().loadTabs(session.id); } catch { /* surfaced via connection state */ }
  }

  async function archiveProject() {
    setProjArchive(false);
    try { await useProjects.getState().archive(session.id); } catch { /* surfaced via connection state */ }
  }

  const renderSection = (sec: (typeof SECTIONS)[number]) => {
    const items = tabs.filter((t) => sec.types.includes(t.type));
    // On mobile, always show FILES (even with no pinned files) so "Browse Files" has a home.
    const filesMobile = sec.key === 'files' && isMobile && !!onBrowseFiles;
    if (sec.key !== 'threads' && !items.length && !filesMobile) return null;
    return (
      <div key={sec.key} style={{ marginTop: sec.prominent ? 10 : 6 }}>
        <SectionHeader label={sec.label} count={items.length} prominent={sec.prominent}>
          {sec.add && (
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <button title={`Add ${sec.label.toLowerCase()}`} onClick={(e) => {
                e.stopPropagation();
                if (sec.add === 'menu') setMenu((o) => !o);
                else if (sec.add === 'browser') void addTab('browser', { url: 'about:blank' });
                else if (sec.add === 'notes') void addTab('notes');
              }} style={plusStyle}>+</button>
              {sec.add === 'menu' && menu && <NewTabMenu sessionId={session.id} onClose={() => setMenu(false)} onCreated={onSelectTab} />}
            </span>
          )}
        </SectionHeader>
        {items.map((t) => (
          <ThreadRow key={t.id} tab={t} active={t.id === activeTabId}
            onClick={(e) => { e.stopPropagation(); onSelectTab(t.id); }}
            onMiddle={() => useTabs.getState().openTab(t.id, true)}
            onArchive={() => setArchiveTarget(t)}
            onContext={(x, y) => setCtxMenu({ tab: t, x, y })} />
        ))}
        {sec.key === 'threads' && !items.length && <div style={{ padding: '3px 7px', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No threads yet</div>}
        {filesMobile && (
          <button onClick={(e) => { e.stopPropagation(); onBrowseFiles!(session.id); }}
            style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '15px 12px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-primary)', fontSize: 16, fontWeight: 450, textAlign: 'left', cursor: 'pointer' }}>
            <FolderOpen size={20} weight="fill" color="var(--color-accent)" style={{ flexShrink: 0 }} />
            <span style={{ flex: 1 }}>Browse Files</span>
            <CaretRight size={16} color="var(--color-text-tertiary)" />
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: (!isMobile && active) ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)' : (!isMobile && hover) ? 'rgba(255,255,255,0.04)' : 'transparent',
        border: (!isMobile && active) ? '1px solid color-mix(in srgb, var(--color-accent) 45%, transparent)' : '1px solid transparent',
        borderRadius: 8, padding: isMobile ? '0 4px' : 4, marginBottom: 4, cursor: active ? 'default' : 'pointer', transition: 'background 0.12s ease, border-color 0.12s ease',
      }}
    >
      <div style={{ padding: isMobile ? '4px 8px 8px' : '5px 6px 4px' }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setProjMenu({ x: e.clientX, y: e.clientY }); }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 600, fontSize: isMobile ? 19 : pfs, color: (!isMobile && active) ? '#fff' : 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.name}</span>
          {working && <Spinner size={10} />}
          <span title={session.lastActivityAt ?? ''} style={{ marginLeft: 'auto', flexShrink: 0, font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{timeAgo(session.lastActivityAt)}</span>
          {(hover || projMenu) && (
            <button title="Project options" onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setProjMenu({ x: r.right, y: r.bottom + 4 }); }}
              style={{ width: 18, height: 18, flexShrink: 0, marginLeft: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 15, lineHeight: 1, borderRadius: 4 }}>⋯</button>
          )}
        </div>
        <div title={session.workingDir} style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{homePath(session.workingDir)}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateRows: active ? '1fr' : '0fr', transition: 'grid-template-rows 0.2s ease' }}>
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          {renderSection(SECTIONS[0])}
          <div style={{ marginTop: 10 }}>
            <SectionHeader label="AGENTS" count={agents.length} prominent>
              <button title="Add agent" onClick={(e) => { e.stopPropagation(); onNewAgent?.(session.id); }} style={plusStyle}>+</button>
            </SectionHeader>
            {agents.map((a) => (
              <AgentRow key={a.id} agent={a} active={agentFocused && a.id === agentSel} onClick={() => onSelectAgent?.(a.id)} />
            ))}
            {!agents.length && <div style={{ padding: '3px 7px', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No agents yet</div>}
          </div>
          {SECTIONS.slice(1).map(renderSection)}
        </div>
      </div>

      {ctxMenu && createPortal(
        <>
          <div onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }} style={{ position: 'fixed', inset: 0, zIndex: 300 }} />
          <div style={{ position: 'fixed', top: ctxMenu.y, left: Math.min(ctxMenu.x, window.innerWidth - 184), zIndex: 301, minWidth: 168, background: '#1B1B1E', border: '1px solid #2C2C32', borderRadius: 9, padding: 4, boxShadow: '0 20px 50px -20px rgba(0,0,0,.8)' }}>
            <button onClick={() => { setRenameTarget(ctxMenu.tab); setCtxMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13 }}>Rename thread</button>
            <button onClick={() => { setArchiveTarget(ctxMenu.tab); setCtxMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-status-red)', cursor: 'pointer', fontSize: 13 }}>Archive thread</button>
          </div>
        </>,
        document.body,
      )}

      {projMenu && createPortal(
        <>
          <div onClick={() => setProjMenu(null)} onContextMenu={(e) => { e.preventDefault(); setProjMenu(null); }} style={{ position: 'fixed', inset: 0, zIndex: 300 }} />
          <div style={{ position: 'fixed', top: projMenu.y, left: Math.min(projMenu.x, window.innerWidth - 184), zIndex: 301, minWidth: 168, background: '#1B1B1E', border: '1px solid #2C2C32', borderRadius: 9, padding: 4, boxShadow: '0 20px 50px -20px rgba(0,0,0,.8)' }}>
            <button onClick={() => { setProjArchive(true); setProjMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-status-red)', cursor: 'pointer', fontSize: 13 }}>Archive project</button>
          </div>
        </>,
        document.body,
      )}

      <ConfirmModal
        open={!!archiveTarget}
        title="Archive thread?"
        message={archiveTarget ? `“${archiveTarget.label}” will be archived. You can restore it later from the archive.` : ''}
        confirmLabel="Archive"
        danger
        onConfirm={() => { if (archiveTarget) void archive(archiveTarget); }}
        onCancel={() => setArchiveTarget(null)}
      />

      <ConfirmModal
        open={projArchive}
        title="Archive project?"
        message={`“${session.name}” and its threads will be archived. You can restore it later.`}
        confirmLabel="Archive"
        danger
        onConfirm={() => void archiveProject()}
        onCancel={() => setProjArchive(false)}
      />

      {renameTarget && (
        <RenameThreadModal
          terminalId={renameTarget.id}
          sessionId={session.id}
          current={renameTarget.label}
          onClose={() => setRenameTarget(null)}
        />
      )}
    </div>
  );
}
