import { useState } from 'react';
import { useAgents } from '../../stores/agents';
import { StatusDot } from '../common/StatusDot';

export function AgentsRail({ onNew }: { onNew: () => void }) {
  const schedules = useAgents((s) => s.schedules);
  const selectedId = useAgents((s) => s.selectedId);
  const [q, setQ] = useState('');
  const filtered = schedules.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div style={{ width: 280, flexShrink: 0, background: 'var(--color-pane)', borderRight: '1px solid var(--color-border)', overflow: 'auto', padding: 8 }}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents"
        style={{ height: 32, width: '100%', padding: '0 10px', marginBottom: 8, background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-primary)', fontSize: 13 }} />
      <button onClick={onNew} style={{ height: 34, width: '100%', marginBottom: 12, background: 'var(--color-accent)', border: 'none', borderRadius: 8, color: '#08240F', fontWeight: 600, cursor: 'pointer' }}>+ New Agent</button>
      {filtered.map((s) => (
        <button key={s.id} onClick={() => void useAgents.getState().select(s.id)} style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 8px',
          background: s.id === selectedId ? 'var(--color-elevated)' : 'transparent', border: 'none', borderRadius: 7,
          color: 'var(--color-text-primary)', textAlign: 'left', cursor: 'pointer', fontSize: 13,
        }}>
          <StatusDot state={s.enabled ? 'idle' : 'disabled'} size={7} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
        </button>
      ))}
      {!filtered.length && <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12.5, padding: '4px 8px' }}>No agents yet</div>}
    </div>
  );
}
