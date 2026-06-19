import { useState } from 'react';
import { AgentSidebar } from './AgentSidebar';
import { AgentDashboard } from './AgentDashboard';
import { AgentsEmpty } from './AgentsEmpty';
import { RunnerView } from './RunnerView';
import { EditAgentModal } from './EditAgentModal';
import { useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import { useIsMobile } from '../../hooks/useIsMobile';

export function AgentsView() {
  const schedules = useAgents((s) => s.schedules);
  const selectedId = useAgents((s) => s.selectedId);
  const isMobile = useIsMobile();
  const [edit, setEdit] = useState<{ open: boolean; scheduleId: string | null; preset: string | null }>({ open: false, scheduleId: null, preset: null });
  const [runId, setRunId] = useState<string | null>(null);
  const [screen, setScreen] = useState<'list' | 'dash' | 'run'>('list');

  const newInProject = (projectId: string) => setEdit({ open: true, scheduleId: null, preset: projectId });
  const newAnywhere = () => setEdit({ open: true, scheduleId: null, preset: useProjects.getState().sessions[0]?.id ?? null });
  const openEdit = () => setEdit({ open: true, scheduleId: useAgents.getState().selectedId, preset: null });
  const openRun = (id: string) => { setRunId(id); if (isMobile) setScreen('run'); };
  const modal = edit.open && <EditAgentModal scheduleId={edit.scheduleId} presetProjectId={edit.preset} onClose={() => setEdit({ open: false, scheduleId: null, preset: null })} />;

  const sidebar = (
    <AgentSidebar
      onNewAgent={newInProject}
      onSelectAgent={() => { setRunId(null); if (isMobile) setScreen('dash'); }}
    />
  );

  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {screen === 'list' && sidebar}
        {screen === 'dash' && (selectedId
          ? <AgentDashboard onEdit={openEdit} onOpenRun={openRun} onBack={() => setScreen('list')} />
          : <AgentsEmpty onNew={newAnywhere} />)}
        {screen === 'run' && runId && <RunnerView runId={runId} onBack={() => setScreen('dash')} />}
        {modal}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ width: 280, flexShrink: 0, borderRight: '1px solid var(--color-border)', background: 'var(--color-pane)' }}>{sidebar}</div>
      {runId
        ? <RunnerView runId={runId} onBack={() => setRunId(null)} />
        : selectedId
          ? <AgentDashboard onEdit={openEdit} onOpenRun={openRun} />
          : schedules.length
            ? <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>Select an agent, or add one to a project.</div>
            : <AgentsEmpty onNew={newAnywhere} />}
      {modal}
    </div>
  );
}
