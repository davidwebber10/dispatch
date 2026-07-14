import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { SortableList } from '../common/SortableList';
import { SwipeRow } from '../common/SwipeRow';
import { FolderOpen, CaretRight, Network, TerminalWindow, ChatCircle, PushPin, Timer } from '@phosphor-icons/react';
import type { Session, Terminal, AgentSchedule } from '../../api/types';
import { useTabs } from '../../stores/tabs';
import { projectIndicator } from '../../lib/status';
import { getAutoArchiveMs, remainingMs, formatRemaining, toDuration, useMinuteTick } from '../../lib/autoArchive';
import { useProjects } from '../../stores/projects';
import { useAgents } from '../../stores/agents';
import { useAgentUI } from '../../stores/agentUI';
import { StatusDot } from '../common/StatusDot';
import { Spinner } from '../common/Spinner';
import { ConfirmModal } from '../common/ConfirmModal';
import { providerColor, fileVisual } from '../common/typeIcons';
import { useSettings, useDispatchName, type Density } from '../../stores/settings';
import { useIsMobile } from '../../hooks/useIsMobile';
import { timeAgo } from '../../lib/time';
import { NewTabMenu } from './NewTabMenu';
import { NewThreadModal, type NewThreadKind } from './NewThreadModal';
import { RenameProjectModal } from './RenameProjectModal';
import { RenameThreadModal } from './RenameThreadModal';
import { AutoArchiveModal } from './AutoArchiveModal';
import { api } from '../../api/client';

/* The sidebar's search header is sticky (~52px). A row revealed by scrollIntoView would sit
   underneath it without this margin. */
const SCROLL_MARGIN = 60;

function dotState(status: string): 'working' | 'idle' | 'needs_input' | 'error' {
  if (status === 'working') return 'working';
  if (status === 'needs_input') return 'needs_input';
  if (status === 'error') return 'error';
  return 'idle';
}

// Project-view density: scales row padding + section spacing (desktop). Mobile
// rows stay finger-sized regardless.
const DENSITY: Record<Density, { rowY: number; sectionMt: number; rowGap: number }> = {
  compact: { rowY: 3, sectionMt: 4, rowGap: 1 },
  cozy: { rowY: 6, sectionMt: 7, rowGap: 3 },
  roomy: { rowY: 10, sectionMt: 12, rowGap: 5 },
};

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

function ThreadRow({ tab, active, fadeKey, onClick, onMiddle, onArchive, onContext }: { tab: Terminal; active: boolean; fadeKey?: number; onClick: (e: React.MouseEvent) => void; onMiddle: () => void; onArchive: () => void; onContext: (x: number, y: number) => void }) {
  const [hover, setHover] = useState(false);
  const color = providerColor(tab.type);
  const loading = useTabs((s) => !!s.loading[tab.id]);
  const fs = useSettings((s) => s.sidebarFontSize);
  const density = useSettings((s) => s.density);
  const isMobile = useIsMobile();
  const dot = isMobile ? 11 : 8;
  const padY = isMobile ? 15 : DENSITY[density].rowY;
  const working = loading || tab.status === 'working';
  const needsAttn = tab.status === 'needs_input' || tab.status === 'error';
  // A structured (stream-json) Claude thread is the chat surface (ChatView) → a chat
  // bubble; PTY Claude / Codex / shell are terminal-backed → one TerminalWindow glyph.
  // Both are tinted by provider color (blue/green/neutral) so the kind still reads at a
  // glance; browser/notes keep a dot. Every leading glyph sits in a fixed-width slot
  // (iconSlot) so labels line up no matter which glyph — or dot — a row shows.
  const structuredClaude = tab.type === 'claude-code' && (tab.config as { transport?: string })?.transport === 'structured';
  const isTerminalThread = !structuredClaude && (tab.type === 'claude-code' || tab.type === 'codex' || tab.type === 'shell');
  const iconSlot = isMobile ? 18 : 15;
  // Auto-archive threads trade their timeAgo for a countdown: both derive from
  // lastActivityAt, and "how long until this disappears" is the more useful read.
  // Only rows with a policy subscribe to the shared ticker — the vast majority of
  // threads have none, and shouldn't re-render every minute just to sit idle.
  const autoArchiveMs = getAutoArchiveMs(tab.config);
  const now = useMinuteTick(autoArchiveMs !== null);
  const left = autoArchiveMs === null ? null : remainingMs(tab.lastActivityAt ?? tab.createdAt, autoArchiveMs, now);
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
      data-thread-id={tab.id}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => onClick(e)}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onMiddle(); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContext(e.clientX, e.clientY); }}
      style={{
        // Keep a revealed row clear of the sidebar's sticky search header — without this,
        // scrollIntoView happily parks the row underneath it.
        scrollMarginTop: SCROLL_MARGIN,
        display: 'flex', alignItems: 'center', gap: isMobile ? 12 : 9, width: '100%', padding: isMobile ? '15px 12px' : `${padY}px 9px`,
        // Selecting snaps instantly; the transition only applies while the mobile
        // fade-back dims the row (dimmed → true), so it eases out, not in.
        transition: dimmed ? 'background .8s ease, color .8s ease' : 'none',
        background: showActive ? '#2a2a31' : hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        borderRadius: isMobile ? 0 : (showActive ? 0 : 5), border: 'none', borderBottom: isMobile ? '1px solid var(--color-border)' : 'none',
        color: showActive ? '#fff' : 'var(--color-text-primary)', fontSize: isMobile ? 16 : fs, fontWeight: showActive ? 600 : isMobile ? 450 : 400,
        textAlign: 'left', cursor: 'pointer',
        // Long-press opens the options menu — stop iOS from selecting the label
        // text / showing the callout, and kill the tap-flash.
        WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none', WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span style={{ width: iconSlot, height: iconSlot, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {tab.type === 'file'
          ? (() => { const fv = fileVisual(tab.label); return <fv.Icon size={iconSlot} weight="fill" color={fv.color} />; })()
          : structuredClaude
            ? <ChatCircle size={isMobile ? 17 : 14} weight="fill" color={color} />
            : isTerminalThread
              ? <TerminalWindow size={isMobile ? 17 : 14} weight="fill" color={color} />
              : <span style={{ width: dot, height: dot, borderRadius: '50%', background: color }} />}
      </span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.label}</span>
      {isMobile && (tab.config as { pinned?: boolean })?.pinned && (
        <PushPin size={13} weight="fill" color="var(--color-text-tertiary)" style={{ flexShrink: 0, marginLeft: 4 }} />
      )}
      <span style={{ flexShrink: 0, marginLeft: 8, minWidth: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        {isMobile && (
          <span role="button" title="Thread options" aria-label="Thread options"
            onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); onContext(r.left, r.bottom); }}
            style={{ width: 28, height: 28, marginRight: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: 'var(--color-text-secondary)', fontSize: 18, lineHeight: 1 }}>⋯</span>
        )}
        {hover && !isMobile ? (
          <span role="button" title="Archive thread" onClick={(e) => { e.stopPropagation(); onArchive(); }}
            style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, color: 'var(--color-text-secondary)', fontSize: 14, lineHeight: 1, cursor: 'pointer' }}>×</span>
        ) : working ? (
          <Spinner size={isMobile ? 13 : 11} />
        ) : needsAttn ? (
          <StatusDot state={dotState(tab.status)} size={isMobile ? 9 : 7} />
        ) : left !== null && autoArchiveMs !== null ? (
          <span
            title={`Archives after ${toDuration(autoArchiveMs).value} ${toDuration(autoArchiveMs).unit} of inactivity`}
            style={{ display: 'flex', alignItems: 'center', gap: 3, font: `400 ${isMobile ? 12 : 10.5}px var(--font-mono)`, color: showActive ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}
          >
            <Timer size={isMobile ? 12 : 10} weight="fill" />
            {formatRemaining(left)}
          </span>
        ) : (
          <span style={{ font: `400 ${isMobile ? 12 : 10.5}px var(--font-mono)`, color: showActive ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>{timeAgo(tab.lastActivityAt ?? tab.createdAt)}</span>
        )}
      </span>
    </button>
  );
}

function AgentRow({ agent, active, onClick }: { agent: AgentSchedule; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const fs = useSettings((s) => s.sidebarFontSize);
  const density = useSettings((s) => s.density);
  const isMobile = useIsMobile();
  const padY = isMobile ? 15 : DENSITY[density].rowY;
  const dot = isMobile ? 11 : 8;
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        display: 'flex', alignItems: 'center', gap: isMobile ? 12 : 9, width: '100%', padding: isMobile ? '15px 12px' : `${padY}px 9px`,
        background: active ? '#2a2a31' : hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        borderRadius: isMobile ? 0 : (active ? 0 : 5), border: 'none', borderBottom: isMobile ? '1px solid var(--color-border)' : 'none',
        color: active ? '#fff' : 'var(--color-text-primary)', fontSize: isMobile ? 16 : fs,
        fontWeight: active ? 600 : isMobile ? 450 : 400, textAlign: 'left', cursor: 'pointer', opacity: agent.enabled ? 1 : 0.55,
      }}
    >
      <span style={{ width: dot, height: dot, borderRadius: '50%', background: providerColor(agent.provider), flexShrink: 0 }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.name}</span>
      <span style={{ flexShrink: 0, marginLeft: 8, font: `400 ${isMobile ? 12 : 10.5}px var(--font-mono)`, color: active ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)' }}>{timeAgo(agent.createdAt)}</span>
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

export function ProjectCard({ session, active, open, onToggle, onSelectTab, onSelectAgent, onNewAgent, onBrowseFiles, onDispatch, fadeActiveKey, highlightTabId, showManaged = false }: { session: Session; active: boolean; open?: boolean; onToggle?: () => void; onSelectTab: (id: string) => void; onSelectAgent?: (id: string) => void; onNewAgent?: (projectId: string) => void; onBrowseFiles?: (projectId: string) => void; onDispatch?: (projectId: string) => void; fadeActiveKey?: number; highlightTabId?: string | null; showManaged?: boolean }) {
  const allAgents = useAgents((s) => s.schedules);
  const dispatchName = useDispatchName();
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
  const [autoArchiveTarget, setAutoArchiveTarget] = useState<Terminal | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'thread'; thread: Terminal } | { kind: 'agent'; agent: AgentSchedule } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ tab: Terminal; x: number; y: number } | null>(null);
  const [projMenu, setProjMenu] = useState<{ x: number; y: number } | null>(null);
  const [projArchive, setProjArchive] = useState(false);
  const [renameProj, setRenameProj] = useState(false);
  const [newThread, setNewThread] = useState<NewThreadKind | null>(null);
  const [projTab, setProjTab] = useState<'threads' | 'agents'>('threads');
  const loadingMap = useTabs((s) => s.loading);
  const pfs = useSettings((s) => s.projectFontSize);
  const density = useSettings((s) => s.density);
  const isMobile = useIsMobile();
  // Expansion is decoupled from the active highlight on desktop; on mobile the
  // project screen is always expanded (open defaults to active when not provided).
  const isOpen = open ?? active;
  const plusStyle: React.CSSProperties = isMobile ? { ...plusBtn, width: 34, height: 34, font: '500 26px/1 var(--font-sans)', borderRadius: 12 } : plusBtn;
  // Roll the project's threads up to one header indicator (needs_input > working
  // > error > idle), combining the backend's session.status with live tab state.
  // Dispatch-managed threads (the coordinator + typed agents) are owned by the
  // Dispatch view; hide them from the Operator sidebar and its counts.
  const isManaged = (t: Terminal) => (t.config?.role === 'coordinator') || !!(t.config as any)?.agentType;
  // Dispatch mode (showManaged): show ONLY the ephemeral typed agents — exclude
  // the coordinator and normal threads. Operator (default): hide all managed rows.
  const isEphemeralAgent = (t: Terminal) => {
    const role = t.config?.role;
    return role === 'agent' || (!!(t.config as any)?.agentType && role !== 'coordinator');
  };
  const showRow = (t: Terminal) => (showManaged ? isEphemeralAgent(t) : !isManaged(t));
  const visibleTabs = tabs.filter(showRow);
  const indicator = projectIndicator(session.status, visibleTabs.map((t) => t.status), visibleTabs.some((t) => loadingMap[t.id]));
  const threadItems = visibleTabs.filter((t) => SECTIONS[0].types.includes(t.type));
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

  async function branch(tab: Terminal) {
    try {
      const t = await api.branchTerminal(tab.id);
      await useTabs.getState().loadTabs(session.id);
      useTabs.getState().markLoading(t.id);
      onSelectTab(t.id);
    } catch { /* e.g. 422 if the thread hasn't started a session yet */ }
  }

  async function deleteAgent(a: AgentSchedule) {
    try { await api.deleteSchedule(a.id); await useAgents.getState().loadSchedules(); } catch { /* surfaced via connection state */ }
  }

  async function archiveProject() {
    setProjArchive(false);
    try { await useProjects.getState().archive(session.id); } catch { /* surfaced via connection state */ }
  }

  const renderSection = (sec: (typeof SECTIONS)[number]) => {
    const items = tabs.filter((t) => sec.types.includes(t.type) && showRow(t));
    if (sec.key !== 'threads' && !items.length) return null;
    return (
      <div key={sec.key} style={{ marginTop: sec.prominent ? DENSITY[density].sectionMt : Math.round(DENSITY[density].sectionMt * 0.7) }}>
        <SectionHeader label={sec.label} count={items.length} prominent={sec.prominent}>
          {sec.add && (
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <button title={`Add ${sec.label.toLowerCase()}`} onClick={(e) => {
                e.stopPropagation();
                if (sec.add === 'menu') setMenu((o) => !o);
                else if (sec.add === 'browser') void addTab('browser', { url: 'about:blank' });
                else if (sec.add === 'notes') void addTab('notes');
              }} style={plusStyle}>+</button>
              {sec.add === 'menu' && menu && <NewTabMenu onClose={() => setMenu(false)} onPick={(kind) => setNewThread(kind)} />}
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
      data-project-id={session.id}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        scrollMarginTop: SCROLL_MARGIN,
        // Clean 4-tier hierarchy (desktop): unselected → hover → open → selected.
        //  unselected: transparent, no border
        //  hover:      faint wash, no border (a quick affordance)
        //  open:       calm bg + neutral border (a contained card)
        //  selected:   accent border only, no wash (the active project)
        background: isMobile ? 'transparent'
          : active ? 'transparent'
          : isOpen ? 'rgba(255,255,255,0.022)'
          : hover ? 'rgba(255,255,255,0.05)'
          : 'transparent',
        border: (!isMobile && active) ? '2px solid color-mix(in srgb, var(--color-accent) 45%, transparent)'
          : (!isMobile && isOpen) ? '2px solid #3a3a42'
          : '2px solid transparent',
        borderRadius: 8, padding: isMobile ? 0 : '4px 0', marginBottom: 4, cursor: 'default', transition: 'background 0.12s ease, border-color 0.12s ease',
      }}
    >
      <div
        onClick={() => { if (!isMobile) onToggle?.(); }}
        style={{ padding: isMobile ? '4px 8px 8px' : '5px 6px 4px', cursor: isMobile ? 'default' : 'pointer' }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setProjMenu({ x: e.clientX, y: e.clientY }); }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 600, fontSize: isMobile ? 19 : pfs, color: (!isMobile && active) ? '#fff' : 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.name}</span>
          {!isMobile && (
            <span title={session.lastActivityAt ?? ''} style={{ marginLeft: 'auto', flexShrink: 0, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', lineHeight: 1 }}>
              {indicator === 'working' ? <Spinner size={11} />
                : indicator === 'needs_input' ? <StatusDot state="needs_input" size={8} />
                : indicator === 'error' ? <StatusDot state="error" size={8} />
                : <span style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{timeAgo(session.lastActivityAt)}</span>}
            </span>
          )}
          {(hover || projMenu) && (
            <button title="Project options" onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setProjMenu({ x: r.right, y: r.bottom + 4 }); }}
              style={{ width: 18, height: 18, flexShrink: 0, marginLeft: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 15, lineHeight: 1, borderRadius: 4 }}>⋯</button>
          )}
        </div>
        <div title={session.workingDir} style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{homePath(session.workingDir)}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateRows: isOpen ? '1fr' : '0fr', transition: 'grid-template-rows 0.12s ease' }}>
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          {/* Dispatch coordinator — desktop opens it as a tab; mobile as a full-screen overlay. */}
          {onDispatch && (
            <button
              onClick={(e) => { e.stopPropagation(); onDispatch(session.id); }}
              title={`Open ${dispatchName} coordinator`}
              style={{
                display: 'flex', alignItems: 'center', gap: isMobile ? 11 : 8,
                margin: isMobile ? '6px 12px 10px' : '4px 9px 6px',
                padding: isMobile ? '14px 12px' : '7px 9px',
                background: 'var(--color-elevated)',
                border: '1px solid var(--color-border)',
                borderRadius: isMobile ? 12 : 7,
                color: 'var(--color-text-secondary)', font: `600 ${isMobile ? 16 : 12.5}px var(--font-sans)`,
                textAlign: 'left', cursor: 'pointer',
              }}
            >
              <Network size={isMobile ? 20 : 15} weight="fill" style={{ flexShrink: 0 }} />
              <span style={{ flex: 1 }}>Open {dispatchName}</span>
              <CaretRight size={isMobile ? 16 : 13} style={{ flexShrink: 0, opacity: 0.75 }} />
            </button>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, marginTop: isMobile ? 6 : 4, marginBottom: 6, padding: isMobile ? '0 12px' : '0 9px', borderBottom: '1px solid var(--color-border)', background: 'rgba(255,255,255,0.03)' }}>
            <TabPill label="Threads" count={threadItems.length} active={projTab === 'threads'} mobile={isMobile} onClick={() => setProjTab('threads')} />
            <TabPill label="Automations" count={agents.length} active={projTab === 'agents'} mobile={isMobile} onClick={() => setProjTab('agents')} />
            <span style={{ flex: 1 }} />
            {projTab === 'threads' ? (
              <span style={{ alignSelf: 'center', position: 'relative', display: 'inline-flex' }}>
                <button title="Add thread" onClick={(e) => { e.stopPropagation(); setMenu((o) => !o); }} style={plusStyle}>+</button>
                {menu && <NewTabMenu onClose={() => setMenu(false)} onPick={(kind) => setNewThread(kind)} />}
              </span>
            ) : (
              <button title="Add automation" onClick={(e) => { e.stopPropagation(); onNewAgent?.(session.id); }} style={{ ...plusStyle, alignSelf: 'center' }}>+</button>
            )}
          </div>
          {projTab === 'threads' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: isMobile ? 0 : DENSITY[density].rowGap }}>
              <SortableList
                items={threadItems}
                disabled={false}
                onReorder={(orderedIds) => void useTabs.getState().reorder(session.id, orderedIds)}
                renderItem={(t) => (
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
                )}
              />
              {!threadItems.length && <div style={{ padding: '3px 7px', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No threads yet</div>}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: isMobile ? 0 : DENSITY[density].rowGap }}>
              {agents.map((a) => (
                <SwipeRow key={a.id} disabled={!isMobile} actionLabel="Delete" actionColor="var(--color-status-red)" onAction={() => setPendingDelete({ kind: 'agent', agent: a })}>
                  <AgentRow agent={a} active={agentFocused && a.id === agentSel} onClick={() => onSelectAgent?.(a.id)} />
                </SwipeRow>
              ))}
              {!agents.length && <div style={{ padding: '3px 7px', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No automations yet</div>}
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
            {ctxMenu.tab.type === 'claude-code' && (
              <button onClick={() => { void branch(ctxMenu.tab); setCtxMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13 }}>Branch thread</button>
            )}
            {(ctxMenu.tab.type === 'claude-code' || ctxMenu.tab.type === 'codex' || ctxMenu.tab.type === 'shell') && (
              <button onClick={() => { setAutoArchiveTarget(ctxMenu.tab); setCtxMenu(null); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13 }}>
                Auto-archive…
              </button>
            )}
            {/* "Unpin" on file rows means archive (below) — thread pinning is threads-only,
                and mobile-only: the Pinned surface is the mobile bottom tab. */}
            {isMobile && ctxMenu.tab.type !== 'file' && (
              <button onClick={() => { void useTabs.getState().setPinned(ctxMenu.tab.id, !(ctxMenu.tab.config as { pinned?: boolean })?.pinned); setCtxMenu(null); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13 }}>{(ctxMenu.tab.config as { pinned?: boolean })?.pinned ? 'Unpin thread' : 'Pin thread'}</button>
            )}
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
        title={pendingDelete?.kind === 'agent' ? 'Delete automation?' : 'Delete thread?'}
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

      {autoArchiveTarget && (
        <AutoArchiveModal tab={autoArchiveTarget} onClose={() => setAutoArchiveTarget(null)} />
      )}

      {newThread && (
        <NewThreadModal
          sessionId={session.id}
          initialKind={newThread}
          onClose={() => setNewThread(null)}
          onCreated={(id) => onSelectTab(id)}
        />
      )}
    </div>
  );
}

function TabPill({ label, count, active, mobile, onClick }: { label: string; count: number; active: boolean; mobile: boolean; onClick: () => void }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick(); }} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: mobile ? '9px 4px 8px' : '6px 3px 7px', background: 'transparent', border: 'none', cursor: 'pointer',
      borderBottom: active ? '2px solid var(--color-accent)' : '2px solid transparent', marginBottom: -1,
      color: active ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
      font: `700 ${mobile ? 13 : 11}px var(--font-mono)`, letterSpacing: '1.1px', transition: 'color .12s ease, border-color .12s ease',
    }}>
      {label.toUpperCase()}
      <span style={{ font: `600 ${mobile ? 11 : 9.5}px var(--font-mono)`, color: active ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)', background: active ? 'color-mix(in srgb, var(--color-accent) 22%, transparent)' : 'var(--color-elevated)', borderRadius: 9, padding: '0 6px', lineHeight: mobile ? '17px' : '15px' }}>{count}</span>
    </button>
  );
}
