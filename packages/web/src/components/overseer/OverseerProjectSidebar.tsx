// Overseer — slim left column (spec §"Product refinement": Overseer-mode left
// column = a compact project picker + the active project's coordinator-managed
// child threads). Clicking a project sets it active; clicking a managed thread
// opens the worker lightbox. Themed with the global --color-* tokens to match the
// regular sidebar (compact rows).

import { useEffect, useState } from 'react';
import type { Terminal } from '../../api/types';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useThreadStatus, type ThreadStatus } from '../../stores/threadStatus';
import { AGENT_TYPE, type AgentType } from './types';
import { Icon } from './atoms';

// Live thread status → dot color + pulse (shared shape with WorkerLightbox).
function statusVisual(ts: ThreadStatus | undefined, fallback?: string): { color: string; pulse: boolean } {
  const s = ts?.threadStatus ?? ts?.status ?? fallback;
  if (s === 'working' || s === 'starting') return { color: 'var(--color-accent)', pulse: true };
  if (s === 'needs_input') return { color: 'var(--color-status-yellow)', pulse: false };
  if (s === 'error') return { color: 'var(--color-status-red)', pulse: false };
  return { color: 'var(--color-text-tertiary)', pulse: false };
}

// A structured worker thread = transport 'structured', not the coordinator.
function isManagedThread(t: Terminal): boolean {
  const cfg = t.config ?? {};
  return cfg.transport === 'structured' && cfg.role !== 'coordinator';
}

function MonoHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: '10px 12px 6px', font: '700 10.5px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-tertiary)' }}>
      {children}
    </div>
  );
}

function ProjectRow({ name, active, onClick }: { name: string; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '7px 10px',
        background: active ? '#2a2a31' : hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        border: 'none',
        borderRadius: active ? 0 : 6,
        color: active ? '#fff' : 'var(--color-text-primary)',
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <Icon name="ph-folder-simple" size={14} color={active ? 'var(--color-accent)' : 'var(--color-text-secondary)'} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
    </button>
  );
}

function WorkerRow({ tab, onClick }: { tab: Terminal; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const ts = useThreadStatus((s) => s.byTerminal[tab.id]);
  const vis = statusVisual(ts, tab.status);
  const cfg = (tab.config ?? {}) as { agentType?: AgentType };
  const icon = cfg.agentType && AGENT_TYPE[cfg.agentType] ? AGENT_TYPE[cfg.agentType].icon : 'ph-terminal-window';

  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        width: '100%',
        padding: '6px 10px 6px 22px',
        background: hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        border: 'none',
        borderRadius: 6,
        color: 'var(--color-text-primary)',
        fontSize: 12.5,
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <Icon name={icon} size={13} color="var(--color-text-secondary)" />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.label}</span>
      <span
        style={{
          flex: 'none',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: vis.color,
          animation: vis.pulse ? 'dispatchPulse 2s ease-in-out infinite' : 'none',
        }}
      />
    </button>
  );
}

export function OverseerProjectSidebar({
  onSelectProject,
  onOpenWorker,
}: {
  onSelectProject?: (sessionId: string) => void;
  onOpenWorker: (terminalId: string) => void;
}) {
  const sessions = useProjects((s) => s.sessions);
  const activeId = useProjects((s) => s.activeId);
  const tabs = useTabs((s) => (activeId ? s.byProject[activeId] : undefined)) ?? [];

  // Ensure projects are loaded (defensive — the shell usually loads them).
  useEffect(() => { if (sessions.length === 0) void useProjects.getState().load(); }, [sessions.length]);
  // Load the active project's threads so the managed list populates.
  useEffect(() => { if (activeId) void useTabs.getState().loadTabs(activeId); }, [activeId]);

  const managed = tabs.filter(isManagedThread);

  function selectProject(id: string) {
    useProjects.getState().setActive(id);
    onSelectProject?.(id);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--color-pane)' }}>
      <div className="sidebar-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 6px 10px' }}>
        <MonoHeader>PROJECTS</MonoHeader>
        {sessions.length === 0 && (
          <div style={{ padding: '4px 10px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>No projects</div>
        )}
        {sessions.map((s) => {
          const active = s.id === activeId;
          return (
            <div key={s.id}>
              <ProjectRow name={s.name} active={active} onClick={() => selectProject(s.id)} />
              {active && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, margin: '2px 0 8px' }}>
                  {managed.length === 0 ? (
                    <div style={{ padding: '4px 10px 4px 22px', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                      No agent threads yet
                    </div>
                  ) : (
                    managed.map((t) => <WorkerRow key={t.id} tab={t} onClick={() => onOpenWorker(t.id)} />)
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
