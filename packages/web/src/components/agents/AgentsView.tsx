import { useState } from 'react';
import { AgentsRail } from './AgentsRail';
import { AgentDashboard } from './AgentDashboard';
import { AgentsEmpty } from './AgentsEmpty';
import { RunnerView } from './RunnerView';
import { EditAgentModal } from './EditAgentModal';
import { useAgents } from '../../stores/agents';
import { useIsMobile } from '../../hooks/useIsMobile';

export function AgentsView() {
  const schedules = useAgents((s) => s.schedules);
  const isMobile = useIsMobile();
  const [edit, setEdit] = useState<{ open: boolean; scheduleId: string | null }>({ open: false, scheduleId: null });
  const [runId, setRunId] = useState<string | null>(null);
  const [screen, setScreen] = useState<'list' | 'dash' | 'run'>('list');

  const openNew = () => setEdit({ open: true, scheduleId: null });
  const openEdit = () => setEdit({ open: true, scheduleId: useAgents.getState().selectedId });
  const openRun = (id: string) => { setRunId(id); if (isMobile) setScreen('run'); };
  const modal = edit.open && <EditAgentModal scheduleId={edit.scheduleId} onClose={() => setEdit({ open: false, scheduleId: null })} />;

  if (!schedules.length) {
    return (
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {!isMobile && <AgentsRail onNew={openNew} onSelect={() => setRunId(null)} />}
        <AgentsEmpty onNew={openNew} />
        {modal}
      </div>
    );
  }

  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {screen === 'list' && <AgentsRail mobile onNew={openNew} onSelect={() => setScreen('dash')} />}
        {screen === 'dash' && <AgentDashboard onEdit={openEdit} onOpenRun={openRun} onBack={() => setScreen('list')} />}
        {screen === 'run' && runId && <RunnerView runId={runId} onBack={() => setScreen('dash')} />}
        {modal}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <AgentsRail onNew={openNew} onSelect={() => setRunId(null)} />
      {runId
        ? <RunnerView runId={runId} onBack={() => setRunId(null)} />
        : <AgentDashboard onEdit={openEdit} onOpenRun={openRun} />}
      {modal}
    </div>
  );
}
