import { useEffect } from 'react';
import { TerminalTab } from '../tabs/TerminalTab';
import { useAgents } from '../../stores/agents';
import { api } from '../../api/client';
import { statusColor, formatDuration, runDurationMs } from '../../lib/agentStats';

const ACTIVE = ['queued', 'starting', 'working', 'needs_input'];

export function RunnerView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const run = useAgents((s) => s.runs.find((r) => r.id === runId)) ?? null;
  const schedule = useAgents((s) => s.schedules.find((x) => x.id === run?.scheduleId)) ?? null;

  useEffect(() => { if (run?.unreadSince) void api.markRunOpened(run.id); }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!run) return <div style={{ flex: 1, padding: 24, color: 'var(--color-text-tertiary)' }}>Run not found.</div>;
  const active = ACTIVE.includes(run.status);
  const color = statusColor(run.status);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 18px', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
        <button onClick={onBack} title="Back" style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 14, flexShrink: 0 }}>‹</button>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0, animation: active ? 'dispatchPulse 1.6s ease-in-out infinite' : undefined }} />
        <span style={{ fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{schedule?.name ?? 'Run'}</span>
        <span style={{ font: '500 11px var(--font-mono)', color, flexShrink: 0 }}>{run.status}{active ? ' · live' : ''}</span>
        <span style={{ marginLeft: 'auto', font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', flexShrink: 0, whiteSpace: 'nowrap' }}>
          {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'} · {formatDuration(runDurationMs(run))}
        </span>
        {active && (
          <button onClick={() => void api.cancelRun(run.id)} style={{ height: 30, padding: '0 12px', background: '#241313', border: '1px solid #4A1F22', borderRadius: 8, color: '#F0616D', fontSize: 12, cursor: 'pointer', flexShrink: 0 }}>Stop run</button>
        )}
      </div>
      {run.error && <div style={{ padding: '8px 18px', color: '#F0616D', fontSize: 12.5, fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{run.error}</div>}
      {run.terminalId
        ? <TerminalTab key={run.terminalId} terminalId={run.terminalId} />
        : <div style={{ flex: 1, padding: 24, color: 'var(--color-text-tertiary)' }}>No terminal output for this run.</div>}
    </div>
  );
}
