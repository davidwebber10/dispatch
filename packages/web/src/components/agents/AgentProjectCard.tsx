import { useState } from 'react';
import type { Session, AgentSchedule } from '../../api/types';
import { StatusDot } from '../common/StatusDot';
import { Spinner } from '../common/Spinner';
import { providerColor } from '../common/typeIcons';
import { useSettings } from '../../stores/settings';

const plusBtn: React.CSSProperties = { width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', font: '600 14px/1 var(--font-sans)', borderRadius: 4 };

function homePath(p: string): string {
  return (p || '').replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function AgentRow({ agent, active, working, onClick }: { agent: AgentSchedule; active: boolean; working: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const fs = useSettings((s) => s.sidebarFontSize);
  const color = providerColor(agent.provider);
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 9px',
        background: active ? 'var(--color-hover)' : hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        borderRadius: 6, border: 'none',
        color: active ? '#fff' : 'var(--color-text-primary)', fontSize: fs, fontWeight: active ? 500 : 400,
        textAlign: 'left', cursor: 'pointer', opacity: agent.enabled ? 1 : 0.55,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.name}</span>
      <span style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {working ? <Spinner size={11} /> : <StatusDot state={agent.enabled ? 'idle' : 'disabled'} size={7} />}
      </span>
    </button>
  );
}

export function AgentProjectCard({ session, active, agents, selectedAgentId, workingIds, onToggle, onSelectAgent, onAddAgent }: {
  session: Session;
  active: boolean;
  agents: AgentSchedule[];
  selectedAgentId: string | null;
  workingIds: Set<string>;
  onToggle: () => void;
  onSelectAgent: (id: string) => void;
  onAddAgent: () => void;
}) {
  const [hover, setHover] = useState(false);
  const pfs = useSettings((s) => s.projectFontSize);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: active ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)' : hover ? 'rgba(255,255,255,0.04)' : 'transparent',
        border: active ? '1px solid color-mix(in srgb, var(--color-accent) 45%, transparent)' : '1px solid transparent',
        borderRadius: 8, padding: 4, marginBottom: 4, cursor: 'pointer', transition: 'background 0.12s ease, border-color 0.12s ease',
      }}
    >
      <div style={{ padding: '5px 6px 4px' }} onClick={onToggle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 600, fontSize: pfs, color: active ? '#fff' : 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.name}</span>
          {agents.length > 0 && <span style={{ marginLeft: 'auto', flexShrink: 0, font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{agents.length} agent{agents.length === 1 ? '' : 's'}</span>}
        </div>
        <div title={session.workingDir} style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{homePath(session.workingDir)}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateRows: active ? '1fr' : '0fr', transition: 'grid-template-rows 0.2s ease' }}>
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          <div style={{ marginTop: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px' }}>
              <span style={{ font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)', flex: 1 }}>AGENTS</span>
              <button title="Add agent" onClick={(e) => { e.stopPropagation(); onAddAgent(); }} style={plusBtn}>+</button>
            </div>
            {agents.map((a) => (
              <AgentRow key={a.id} agent={a} active={a.id === selectedAgentId} working={workingIds.has(a.id)} onClick={() => onSelectAgent(a.id)} />
            ))}
            {!agents.length && <div style={{ padding: '2px 6px', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No agents yet</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
