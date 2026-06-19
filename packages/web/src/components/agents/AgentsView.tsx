import { useState } from 'react';
import { AgentsRail } from './AgentsRail';
import { AgentDashboard } from './AgentDashboard';
import { EditAgentModal } from './EditAgentModal';
import { useAgents } from '../../stores/agents';

export function AgentsView() {
  const [edit, setEdit] = useState<{ open: boolean; scheduleId: string | null }>({ open: false, scheduleId: null });
  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <AgentsRail onNew={() => setEdit({ open: true, scheduleId: null })} />
      <AgentDashboard onEdit={() => setEdit({ open: true, scheduleId: useAgents.getState().selectedId })} />
      {edit.open && <EditAgentModal scheduleId={edit.scheduleId} onClose={() => setEdit({ open: false, scheduleId: null })} />}
    </div>
  );
}
