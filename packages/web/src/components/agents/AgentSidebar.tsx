import { useEffect, useState } from 'react';
import { useProjects } from '../../stores/projects';
import { useAgents } from '../../stores/agents';
import { AgentProjectCard } from './AgentProjectCard';

const ACTIVE_RUN = ['queued', 'starting', 'working', 'needs_input'];

export function AgentSidebar({ onSelectAgent, onNewAgent }: { onSelectAgent: () => void; onNewAgent: (projectId: string) => void }) {
  const sessions = useProjects((s) => s.sessions);
  const schedules = useAgents((s) => s.schedules);
  const selectedId = useAgents((s) => s.selectedId);
  const runs = useAgents((s) => s.runs);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  // Auto-expand the project that owns the selected agent.
  const selProjectId = schedules.find((a) => a.id === selectedId)?.projectId ?? null;
  useEffect(() => { if (selProjectId) setExpanded(selProjectId); }, [selProjectId]);

  const workingIds = new Set<string>(selectedId && runs.some((r) => ACTIVE_RUN.includes(r.status)) ? [selectedId] : []);

  const sorted = sessions
    .filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
    .slice()
    .sort((a, b) => {
      const ha = schedules.some((x) => x.projectId === a.id) ? 0 : 1;
      const hb = schedules.some((x) => x.projectId === b.id) ? 0 : 1;
      return ha - hb || a.name.localeCompare(b.name);
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flexShrink: 0, padding: '8px 8px 10px', background: 'var(--color-pane)' }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects"
          style={{ width: '100%', height: 32, padding: '0 10px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-primary)', fontSize: 13 }} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 8px' }}>
        {sorted.map((s) => (
          <AgentProjectCard
            key={s.id}
            session={s}
            active={expanded === s.id}
            agents={schedules.filter((a) => a.projectId === s.id).slice().sort((a, b) => a.name.localeCompare(b.name))}
            selectedAgentId={selectedId}
            workingIds={workingIds}
            onToggle={() => setExpanded((e) => (e === s.id ? null : s.id))}
            onSelectAgent={(id) => { void useAgents.getState().select(id); onSelectAgent(); }}
            onAddAgent={() => { setExpanded(s.id); onNewAgent(s.id); }}
          />
        ))}
        {!sorted.length && <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12.5, padding: '4px 6px' }}>No projects — create one in the Projects tab.</div>}
      </div>
    </div>
  );
}
