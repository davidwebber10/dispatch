import { useEffect, useRef, useState } from 'react';
import { AgentDashboard } from './AgentDashboard';
import { RunnerView } from './RunnerView';
import { useAgentUI } from '../../stores/agentUI';

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

// The workspace main pane when an agent is focused: its dashboard, or a run's runner.
// onClose (desktop) dismisses the pane back to the tabs that were open; Escape does the same,
// or first steps out of a run to the dashboard.
export function AgentPane({ onBack, onClose }: { onBack?: () => void; onClose?: () => void }) {
  const [runId, setRunId] = useState<string | null>(null);
  const runRef = useRef(runId);
  runRef.current = runId;

  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return; // another layer (a menu, a lightbox) took the key
      if (isEditable(e.target)) return;                      // Escape in a text field is that field's
      if (useAgentUI.getState().editing) return;             // the edit modal closes itself
      if (document.querySelector('[role="dialog"], [role="menu"]')) return; // a popover is open
      e.preventDefault();
      if (runRef.current) setRunId(null); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return runId
    ? <RunnerView runId={runId} onBack={() => setRunId(null)} />
    : <AgentDashboard onEdit={() => useAgentUI.getState().openEdit()} onOpenRun={(id) => setRunId(id)} onBack={onBack} onClose={onClose} />;
}
