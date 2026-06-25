import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, CaretRight } from '@phosphor-icons/react';
import type { Session, Terminal, AgentSchedule } from '../../api/types';
import { useTabs } from '../../stores/tabs';
import { useThreadStatus } from '../../stores/threadStatus';
import { projectIndicator } from '../../lib/status';
import { useProjects } from '../../stores/projects';
import { useAgents } from '../../stores/agents';
import { useAgentUI } from '../../stores/agentUI';
import { StatusDot } from '../common/StatusDot';
import { Spinner } from '../common/Spinner';
import { ConfirmModal } from '../common/ConfirmModal';
import { providerColor, fileVisual } from '../common/typeIcons';
import { useSettings } from '../../stores/settings';
import { useIsMobile } from '../../hooks/useIsMobile';
import { timeAgo } from '../../lib/time';
import { NewTabMenu } from './NewTabMenu';
import { RenameProjectModal } from './RenameProjectModal';
import { RenameThreadModal } from './RenameThreadModal';
import { api } from '../../api/client';

function dotState(status: string): 'working' | 'idle' | 'needs_input' | 'error' {
  if (status === 'working') return 'working';
  if (status === 'needs_input') return 'needs_input';
  if (status === 'error') return 'error';
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

// Mobile-only iOS-style swipe row: drag the content left to reveal a single
// action button (Delete / Unpin) behind its right edge. Disabled on desktop,
// where it renders children untouched. The opaque foreground (base bg) hides the
// action when closed; we lock onto the horizontal axis only once the finger
// commits to it so vertical list-scrolling still works, and swallow the tap that
// ends a swipe so it never falls through to the row's navigation.
//
// Like iOS Mail: a slow drag just reveals the button (tap to act); but a far
// drag (past ~half the row) or a fast left flick fires the action directly. The
// action button stretches to meet the dragged edge so there's never a gap.
function SwipeRow({ actionLabel, actionColor, onAction, disabled, children }: { actionLabel: string; actionColor: string; onAction: () => void; disabled?: boolean; children: React.ReactNode }) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dxRef = useRef(0);
  const startX = useRef(0);
  const startY = useRef(0);
  const startDx = useRef(0);
  const axis = useRef<'x' | 'y' | null>(null);
  const moved = useRef(false);
  const openRef = useRef(false);
  const width = useRef(0);
  const lastX = useRef(0);
  const lastT = useRef(0);
  const vx = useRef(0); // px/ms, negative = leftward
  const REVEAL = 84;

  if (disabled) return <>{children}</>;

  const set = (v: number) => { dxRef.current = v; setDx(v); };
  const onStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    startX.current = t.clientX; startY.current = t.clientY; startDx.current = dxRef.current;
    width.current = (e.currentTarget as HTMLElement).offsetWidth;
    lastX.current = t.clientX; lastT.current = Date.now(); vx.current = 0;
    axis.current = null; moved.current = false; setDragging(true);
  };
  const onMove = (e: React.TouchEvent) => {
    const t = e.touches[0];
    const ddx = t.clientX - startX.current;
    const ddy = t.clientY - startY.current;
    if (axis.current === null && (Math.abs(ddx) > 8 || Math.abs(ddy) > 8)) {
      axis.current = Math.abs(ddx) > Math.abs(ddy) ? 'x' : 'y';
    }
    if (axis.current !== 'x') return;
    moved.current = true;
    const now = Date.now();
    const dt = now - lastT.current;
    if (dt > 0) vx.current = (t.clientX - lastX.current) / dt;
    lastX.current = t.clientX; lastT.current = now;
    const cap = width.current ? width.current * 0.95 : REVEAL + 24;
    set(Math.max(-cap, Math.min(0, startDx.current + ddx)));
  };
  const onEnd = () => {
    setDragging(false);
    if (axis.current !== 'x') return;
    const farEnough = dxRef.current < -(width.current * 0.5);
    const fastFlick = vx.current < -0.6 && dxRef.current < -REVEAL / 2;
    if (farEnough || fastFlick) {
      set(0); openRef.current = false;
      onAction();
      return;
    }
    const open = dxRef.current < -REVEAL / 2;
    set(open ? -REVEAL : 0);
    openRef.current = open;
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if (moved.current || openRef.current) {
      e.preventDefault(); e.stopPropagation();
      if (openRef.current && !moved.current) { set(0); openRef.current = false; }
      moved.current = false;
    }
  };
  return (
    <div style={{ position: 'relative', overflow: 'hidden' }}>
      <button onClick={() => { set(0); openRef.current = false; onAction(); }}
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: Math.max(REVEAL, -dx), display: 'flex', alignItems: 'center', justifyContent: 'center', background: actionColor, color: '#fff', border: 'none', font: '600 13px var(--font-sans)', cursor: 'pointer' }}>
        {actionLabel}
      </button>
      <div onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} onClickCapture={onClickCapture}
        style={{ position: 'relative', transform: `translateX(${dx}px)`, transition: dragging ? 'none' : 'transform .22s cubic-bezier(.4,0,.2,1)', background: 'var(--color-base)', touchAction: 'pan-y' }}>
        {children}
      </div>
    </div>
  );
}

function ThreadRow({ tab, active, fadeKey, onClick, onMiddle, onArchive, onContext }: { tab: Terminal; active: boolean; fadeKey?: number; onClick: (e: React.MouseEvent) => void; onMiddle: () => void; onArchive: () => void; onContext: (x: number, y: number) => void }) {
  const [hover, setHover] = useState(false);
  const color = providerColor(tab.type);
  const loading = useTabs((s) => !!s.loading[tab.id]);
  const fs = useSettings((s) => s.sidebarFontSize);
  const isMobile = useIsMobile();
  const dot = isMobile ? 11 : 8;
  // While a thread is working/needs-input, surface its live activity label in
  // place of the timestamp ("Running: npm test", "Editing app.ts").
  const activity = useThreadStatus((s) => s.byTerminal[tab.id]?.activity);
  const liveActivity = (tab.status === 'working' || tab.status === 'needs_input') ? activity : undefined;
  // On mobile, the active row's highlight fades out a couple seconds after the
  // thread list (re)appears (fadeKey bumps), so the list reads as clean.
  const [dimmed, setDimmed] = useState(false);
  useEffect(() => {
    if (fadeKey === undefined || !active) { setDimmed(false); return; }
    setDimmed(false); // show the highlight on arrival…
    const t = setTimeout(() => setDimmed(true), 900); // …hold briefly, then fade out
    return () => clearTimeout(t);
  }, [fadeKey, active]);
  const showActive = active && !dimmed;
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onMiddle(); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext(e.clientX, e.clientY); }}
      style={{
        display: 'flex', alignItems: 'center', gap: isMobile ? 12 : 9, width: '100%', padding: isMobile ? '15px 12px' : '7px 9px',
        transition: 'background .8s ease, color .8s ease',
        background: showActive ? 'var(--color-hover)' : hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        borderRadius: isMobile ? 0 : 6, border: 'none', borderBottom: isMobile ? '1px solid var(--color-border)' : 'none',
        color: showActive ? '#fff' : 'var(--color-text-primary)', fontSize: isMobile ? 16 : fs, fontWeight: showActive ? 500 : isMobile ? 450 : 400,
        textAlign: 'left', cursor: 'pointer',
      }}
    >
      {tab.type === 'file'
        ? (() => { const fv = fileVisual(tab.label); return <fv.Icon size={isMobile ? 18 : 15} weight="fill" color={fv.color} style={{ flexShrink: 0 }} />; })()
        : <span style={{ width: dot, height: dot, borderRadius: '50%', background: color, flexShrink: 0 }} />}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.label}</span>
      <span style={{ flexShrink: 0, maxWidth: isMobile ? 150 : 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `400 ${isMobile ? 12 : 10.5}px var(--font-mono)`, color: liveActivity ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}>
        {liveActivity || timeAgo(tab.lastActivityAt ?? tab.createdAt)}
      </span>
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

export function ProjectCard({ session, active, open, onToggle, onSelectTab, onSelectAgent, onNewAgent, onBrowseFiles, fadeActiveKey, highlightTabId }: { session: Session; active: boolean; open?: boolean; onToggle?: () => void; onSelectTab: (id: string) => void; onSelectAgent?: (id: string) => void; onNewAgent?: (projectId: string) => void; onBrowseFiles?: (projectId: string) => void; fadeActiveKey?: number; highlightTabId?: string | null }) {
  const allAgents = useAgents((s) => s.schedules);
  const agents = allAgents.filter((a) => a.projectId === session.id);
  const agentSel = useAgents((s) => s.selectedId);
  const agentFocused = useAgentUI((s) => s.focused);
  const tabs = useTabs((s) => s.byProject[session.id]) ?? [];
  const activeTabId = useTabs((s) => s.activeTabId);
  // Desktop highlights the open tab persistently (activeTabId). Mobile passes
  // highlightTabId explicitly so the list only highlights a thread you just
  // returned FROM — opening a project fresh highlights nothing (null).
  const highlightId = highlightTabId !== undefined ? highlightTabId : activeTabId;
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<Terminal | null>(null);
  const [renameTarget, setRenameTarget] = useState<Terminal | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'thread'; thread: Terminal } | { kind: 'agent'; agent: AgentSchedule } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ tab: Terminal; x: number; y: number } | null>(null);
  const [projMenu, setProjMenu] = useState<{ x: number; y: number } | null>(null);
  const [projArchive, setProjArchive] = useState(false);
  const [renameProj, setRenameProj] = useState(false);
  const [projTab, setProjTab] = useState<'threads' | 'agents'>('threads');
  const loadingMap = useTabs((s) => s.loading);
  const pfs = useSettings((s) => s.projectFontSize);
  const isMobile = useIsMobile();
  // Expansion is decoupled from the active highlight on desktop; on mobile the
  // project screen is always expanded (open defaults to active when not provided).
  const isOpen = open ?? active;
  const plusStyle: React.CSSProperties = isMobile ? { ...plusBtn, width: 34, height: 34, font: '500 26px/1 var(--font-sans)', borderRadius: 12 } : plusBtn;
  // Roll the project's threads up to one header indicator (needs_input > working
  // > error > idle), combining the backend's session.status with live tab state.
  const indicator = projectIndicator(session.status, tabs.map((t) => t.status), tabs.some((t) => loadingMap[t.id]));
  const threadItems = tabs.filter((t) => SECTIONS[0].types.includes(t.type));
  useEffect(() => { if (isOpen) void useTabs.getState().loadTabs(session.id); }, [isOpen, session.id]);

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

  async function deleteAgent(a: AgentSchedule) {
    try { await api.deleteSchedule(a.id); await useAgents.getState().loadSchedules(); } catch { /* surfaced via connection state */ }
  }

  async function archiveProject() {
    setProjArchive(false);
    try { await useProjects.getState().archive(session.id); } catch { /* surfaced via connection state */ }
  }

  const renderSection = (sec: (typeof SECTIONS)[number]) => {
    const items = tabs.filter((t) => sec.types.includes(t.type));
    if (sec.key !== 'threads' && !items.length) return null;
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
          <SwipeRow key={t.id} disabled={!isMobile}
            actionLabel={t.type === 'file' ? 'Unpin' : 'Delete'}
            actionColor={t.type === 'file' ? '#3F3F46' : 'var(--color-status-red)'}
            onAction={() => { if (t.type === 'file') void archive(t); else setPendingDelete({ kind: 'thread', thread: t }); }}>
            <ThreadRow tab={t} active={t.id === highlightId} fadeKey={fadeActiveKey}
              onClick={(e) => { e.stopPropagation(); onSelectTab(t.id); }}
              onMiddle={() => useTabs.getState().openTab(t.id, true)}
              onArchive={() => setArchiveTarget(t)}
              onContext={(x, y) => setCtxMenu({ tab: t, x, y })} />
          </SwipeRow>
        ))}
        {sec.key === 'threads' && !items.length && <div style={{ padding: '3px 7px', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No threads yet</div>}
      </div>
    );
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        // Active project: a faint accent wash (full-height fade). An expanded-but-
        // not-active project keeps a subtle background so you can see it's open;
        // collapsed projects only tint on hover.
        background: (!isMobile && active) ? 'linear-gradient(180deg, color-mix(in srgb, var(--color-accent) 10%, transparent), transparent)' : (!isMobile && (isOpen || hover)) ? 'rgba(255,255,255,0.04)' : 'transparent',
        border: (!isMobile && active) ? '1px solid color-mix(in srgb, var(--color-accent) 45%, transparent)' : '1px solid transparent',
        borderRadius: 12, padding: isMobile ? '0 4px' : 4, marginBottom: 4, cursor: 'default', transition: 'background 0.12s ease, border-color 0.12s ease',
      }}
    >
      <div
        onClick={() => { if (!isMobile) onToggle?.(); }}
        style={{ padding: isMobile ? '4px 8px 8px' : '5px 6px 4px', cursor: isMobile ? 'default' : 'pointer' }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setProjMenu({ x: e.clientX, y: e.clientY }); }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {!isMobile && (
            <CaretRight size={11} weight="bold" style={{ flexShrink: 0, color: 'var(--color-text-tertiary)', transition: 'transform .15s ease', transform: isOpen ? 'rotate(90deg)' : 'none' }} />
          )}
          <span style={{ fontWeight: 600, fontSize: isMobile ? 19 : pfs, color: (!isMobile && active) ? '#fff' : 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.name}</span>
          {indicator === 'working' && <Spinner size={10} />}
          {indicator === 'needs_input' && <StatusDot state="needs_input" size={8} />}
          {indicator === 'error' && <StatusDot state="error" size={8} />}
          <span title={session.lastActivityAt ?? ''} style={{ marginLeft: 'auto', flexShrink: 0, font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{timeAgo(session.lastActivityAt)}</span>
          {(hover || projMenu) && (
            <button title="Project options" onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setProjMenu({ x: r.right, y: r.bottom + 4 }); }}
              style={{ width: 18, height: 18, flexShrink: 0, marginLeft: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 15, lineHeight: 1, borderRadius: 4 }}>⋯</button>
          )}
        </div>
        <div title={session.workingDir} style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{homePath(session.workingDir)}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateRows: isOpen ? '1fr' : '0fr', transition: 'grid-template-rows 0.2s ease' }}>
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: isMobile ? '10px 8px 6px' : '6px 6px 4px' }}>
            <TabPill label="Threads" count={threadItems.length} active={projTab === 'threads'} mobile={isMobile} onClick={() => setProjTab('threads')} />
            <TabPill label="Agents" count={agents.length} active={projTab === 'agents'} mobile={isMobile} onClick={() => setProjTab('agents')} />
            <span style={{ flex: 1 }} />
            {projTab === 'threads' ? (
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <button title="Add thread" onClick={(e) => { e.stopPropagation(); setMenu((o) => !o); }} style={plusStyle}>+</button>
                {menu && <NewTabMenu sessionId={session.id} onClose={() => setMenu(false)} onCreated={onSelectTab} />}
              </span>
            ) : (
              <button title="Add agent" onClick={(e) => { e.stopPropagation(); onNewAgent?.(session.id); }} style={plusStyle}>+</button>
            )}
          </div>
          {projTab === 'threads' ? (
            <div>
              {threadItems.map((t) => (
                <SwipeRow key={t.id} disabled={!isMobile}
                  actionLabel={t.type === 'file' ? 'Unpin' : 'Delete'}
                  actionColor={t.type === 'file' ? '#3F3F46' : 'var(--color-status-red)'}
                  onAction={() => { if (t.type === 'file') void archive(t); else setPendingDelete({ kind: 'thread', thread: t }); }}>
                  <ThreadRow tab={t} active={t.id === highlightId} fadeKey={fadeActiveKey}
                    onClick={(e) => { e.stopPropagation(); onSelectTab(t.id); }}
                    onMiddle={() => useTabs.getState().openTab(t.id, true)}
                    onArchive={() => setArchiveTarget(t)}
                    onContext={(x, y) => setCtxMenu({ tab: t, x, y })} />
                </SwipeRow>
              ))}
              {!threadItems.length && <div style={{ padding: '3px 7px', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No threads yet</div>}
            </div>
          ) : (
            <div>
              {agents.map((a) => (
                <SwipeRow key={a.id} disabled={!isMobile} actionLabel="Delete" actionColor="var(--color-status-red)" onAction={() => setPendingDelete({ kind: 'agent', agent: a })}>
                  <AgentRow agent={a} active={agentFocused && a.id === agentSel} onClick={() => onSelectAgent?.(a.id)} />
                </SwipeRow>
              ))}
              {!agents.length && <div style={{ padding: '3px 7px', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No agents yet</div>}
            </div>
          )}
          {SECTIONS.slice(1).map(renderSection)}
          {isMobile && onBrowseFiles && (
            <button onClick={(e) => { e.stopPropagation(); onBrowseFiles(session.id); }}
              style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', marginTop: 18, padding: '14px 12px', background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 12, color: 'var(--color-text-primary)', fontSize: 16, fontWeight: 500, textAlign: 'left', cursor: 'pointer' }}>
              <FolderOpen size={20} weight="fill" color="var(--color-accent)" style={{ flexShrink: 0 }} />
              <span style={{ flex: 1 }}>Browse Files</span>
              <CaretRight size={16} color="var(--color-text-tertiary)" />
            </button>
          )}
        </div>
      </div>

      {ctxMenu && createPortal(
        <>
          <div onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }} style={{ position: 'fixed', inset: 0, zIndex: 300 }} />
          <div style={{ position: 'fixed', top: ctxMenu.y, left: Math.min(ctxMenu.x, window.innerWidth - 184), zIndex: 301, minWidth: 168, background: '#1B1B1E', border: '1px solid #2C2C32', borderRadius: 9, padding: 4, boxShadow: '0 20px 50px -20px rgba(0,0,0,.8)' }}>
            <button onClick={() => { setRenameTarget(ctxMenu.tab); setCtxMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13 }}>{ctxMenu.tab.type === 'file' ? 'Rename file' : 'Rename thread'}</button>
            {ctxMenu.tab.type === 'file' ? (
              <button onClick={() => { void archive(ctxMenu.tab); setCtxMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13 }}>Unpin</button>
            ) : (
              <button onClick={() => { setArchiveTarget(ctxMenu.tab); setCtxMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-status-red)', cursor: 'pointer', fontSize: 13 }}>Archive thread</button>
            )}
          </div>
        </>,
        document.body,
      )}

      {projMenu && createPortal(
        <>
          <div onClick={() => setProjMenu(null)} onContextMenu={(e) => { e.preventDefault(); setProjMenu(null); }} style={{ position: 'fixed', inset: 0, zIndex: 300 }} />
          <div style={{ position: 'fixed', top: projMenu.y, left: Math.min(projMenu.x, window.innerWidth - 184), zIndex: 301, minWidth: 168, background: '#1B1B1E', border: '1px solid #2C2C32', borderRadius: 9, padding: 4, boxShadow: '0 20px 50px -20px rgba(0,0,0,.8)' }}>
            <button onClick={() => { setRenameProj(true); setProjMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13 }}>Rename project</button>
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
        open={!!pendingDelete}
        title={pendingDelete?.kind === 'agent' ? 'Delete agent?' : 'Delete thread?'}
        message={
          pendingDelete?.kind === 'agent'
            ? `“${pendingDelete.agent.name}” will be permanently deleted.`
            : pendingDelete?.kind === 'thread'
              ? `“${pendingDelete.thread.label}” will be removed from the list. You can restore it from the archive.`
              : ''
        }
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (pendingDelete?.kind === 'thread') void archive(pendingDelete.thread);
          else if (pendingDelete?.kind === 'agent') void deleteAgent(pendingDelete.agent);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
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

      {renameProj && (
        <RenameProjectModal sessionId={session.id} current={session.name} onClose={() => setRenameProj(false)} />
      )}
    </div>
  );
}

function TabPill({ label, count, active, mobile, onClick }: { label: string; count: number; active: boolean; mobile: boolean; onClick: () => void }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick(); }} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: mobile ? '6px 11px' : '4px 9px', borderRadius: 8, border: 'none', cursor: 'pointer',
      background: active ? 'var(--color-elevated)' : 'transparent',
      color: active ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
      font: `700 ${mobile ? 13 : 11}px var(--font-mono)`, letterSpacing: '1.1px', transition: 'background .12s ease, color .12s ease',
    }}>
      {label.toUpperCase()}
      {count > 0 && (
        <span style={{ font: `600 ${mobile ? 11 : 9.5}px var(--font-mono)`, color: 'var(--color-text-secondary)', background: active ? 'var(--color-pane)' : 'var(--color-elevated)', borderRadius: 9, padding: '0 6px', lineHeight: mobile ? '17px' : '15px' }}>{count}</span>
      )}
    </button>
  );
}
