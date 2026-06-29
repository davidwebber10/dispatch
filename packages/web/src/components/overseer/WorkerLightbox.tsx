// Overseer — Worker lightbox (spec §"Worker lightbox": monitor + interject).
//
// A centered modal overlay (dark scrim + large rounded panel) whose body renders
// the real structured chat View for one worker thread, so the user can monitor the
// worker's live stream-json work AND interject mid-work via the View's composer —
// this is NOT a terminal. Themed like the Delegate modal (overseer/components/
// DelegateModal.tsx) but with the global --color-* tokens so it renders correctly
// wherever the controller mounts it (inside or outside .overseer-root).

import { useEffect } from 'react';
import { ChatView } from '../tabs/chat/ChatView';
import { useTabs, findTerminal } from '../../stores/tabs';
import { useThreadStatus, type ThreadStatus } from '../../stores/threadStatus';
import { AGENT_TYPE, type AgentType } from './types';
import { Icon } from './atoms';
import { AutonomyToggle, InterruptButton } from './components/AutonomyControls';

// Map the live thread status to a dot color + label + whether it should pulse.
function statusVisual(ts: ThreadStatus | undefined, fallback?: string): { color: string; label: string; pulse: boolean } {
  const s = ts?.threadStatus ?? ts?.status ?? fallback;
  if (s === 'working' || s === 'starting') return { color: 'var(--color-accent)', label: 'working', pulse: true };
  if (s === 'needs_input') return { color: 'var(--color-status-yellow)', label: 'waiting on you', pulse: false };
  if (s === 'error') return { color: 'var(--color-status-red)', label: 'error', pulse: false };
  if (s === 'done') return { color: 'var(--color-text-tertiary)', label: 'done', pulse: false };
  return { color: 'var(--color-text-tertiary)', label: 'idle', pulse: false };
}

export function WorkerLightbox({ terminalId, onClose }: { terminalId: string; onClose: () => void }) {
  const terminal = useTabs((s) => findTerminal(s.byProject, terminalId));
  const ts = useThreadStatus((s) => s.byTerminal[terminalId]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cfg = (terminal?.config ?? {}) as { role?: string; agentType?: AgentType; mission?: string; autonomy?: string };
  const isCoordinator = cfg.role === 'coordinator';
  const agentType = cfg.agentType;
  const icon = isCoordinator
    ? 'ph-terminal-window'
    : agentType && AGENT_TYPE[agentType] ? AGENT_TYPE[agentType].icon : 'ph-terminal-window';
  const typeLabel = isCoordinator ? 'coordinator' : (agentType ? AGENT_TYPE[agentType].label : '');
  const vis = statusVisual(ts, terminal?.status);

  return (
    /* Scrim */
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 60,
      }}
    >
      {/* Panel */}
      <div
        style={{
          width: 'min(940px, 94vw)',
          height: 'min(86vh, 900px)',
          background: 'var(--color-base)',
          border: '1px solid var(--color-border)',
          borderRadius: 14,
          boxShadow: '0 30px 80px -20px rgba(0,0,0,.85)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          style={{
            flex: 'none',
            padding: '12px 14px',
            borderBottom: '1px solid var(--color-border)',
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            background: 'var(--color-pane)',
          }}
        >
          {/* type icon box */}
          <div
            style={{
              flex: 'none',
              width: 30,
              height: 30,
              borderRadius: 8,
              background: 'var(--color-elevated)',
              border: '1px solid var(--color-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name={icon} size={16} color="var(--color-accent)" />
          </div>

          {/* label + meta */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {terminal?.label ?? 'Worker'}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '400 11px var(--font-mono)', color: 'var(--color-text-secondary)' }}>
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
              {[typeLabel, vis.label].filter(Boolean).join(' · ')}
              {cfg.mission ? <span style={{ color: 'var(--color-text-tertiary)' }}>{` · ${cfg.mission}`}</span> : null}
            </span>
          </div>

          {/* autonomy dial (agent threads only — coordinators never escalate) + graceful interrupt */}
          {!isCoordinator && (
            <AutonomyToggle terminalId={terminalId} autonomy={cfg.autonomy} scheme="global" />
          )}
          <InterruptButton terminalId={terminalId} scheme="global" />

          {/* close */}
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close"
            style={{
              flex: 'none',
              width: 28,
              height: 28,
              borderRadius: 7,
              background: 'transparent',
              border: '1px solid var(--color-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--color-text-secondary)',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <Icon name="ph-x" size={15} color="var(--color-text-secondary)" />
          </button>
        </div>

        {/* Body — the real structured chat View fills the panel. */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <ChatView terminalId={terminalId} />
        </div>
      </div>
    </div>
  );
}
