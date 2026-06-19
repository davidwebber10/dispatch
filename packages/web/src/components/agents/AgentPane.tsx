import { useState } from 'react';
import { AgentDashboard } from './AgentDashboard';
import { RunnerView } from './RunnerView';
import { useAgentUI } from '../../stores/agentUI';

// The workspace main pane when an agent is focused: its dashboard, or a run's runner.
export function AgentPane({ onBack }: { onBack?: () => void }) {
  const [runId, setRunId] = useState<string | null>(null);
  return runId
    ? <RunnerView runId={runId} onBack={() => setRunId(null)} />
    : <AgentDashboard onEdit={() => useAgentUI.getState().openEdit()} onOpenRun={(id) => setRunId(id)} onBack={onBack} />;
}
