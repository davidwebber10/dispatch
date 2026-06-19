import { api } from '../../api/client';
import { useAgents } from '../../stores/agents';
import { deriveKpis, formatDuration, runDurationMs, statusColor } from '../../lib/agentStats';
import { StatusDot } from '../common/StatusDot';
import type { AgentSchedule } from '../../api/types';

const panel: React.CSSProperties = { background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 12, padding: 14 };
const label: React.CSSProperties = { font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
const green: React.CSSProperties = { height: 30, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 7, color: '#08240F', fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const ghost: React.CSSProperties = { height: 30, padding: '0 14px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-primary)', fontSize: 12, cursor: 'pointer' };

function summarize(s: AgentSchedule): string {
  if (s.scheduleKind === 'one-shot') return 'Manual / one-shot';
  try {
    const r = s.recurrenceRule ? JSON.parse(s.recurrenceRule) : null;
    if (r?.type === 'daily') return `Daily · ${r.time ?? ''}`;
    if (r?.type === 'interval-hours') return `Every ${r.hours}h`;
    if (r?.type === 'weekly') return `Weekly · ${(r.days ?? []).join(',')} ${r.time ?? ''}`;
    if (r?.type === 'cron') return `Cron · ${r.expr ?? ''}`;
  } catch { /* ignore */ }
  return 'Recurring';
}

function Kpi({ label: l, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={panel}>
      <div style={label}>{l}</div>
      <div style={{ fontSize: 21, fontWeight: 600, marginTop: 6, color: accent ? 'var(--color-accent)' : 'var(--color-text-primary)' }}>{value}</div>
    </div>
  );
}

export function AgentDashboard({ onEdit }: { onEdit: () => void }) {
  const schedule = useAgents((s) => s.schedules.find((x) => x.id === s.selectedId)) ?? null;
  const runs = useAgents((s) => s.runs);

  if (!schedule) return <div style={{ flex: 1, padding: 24, color: 'var(--color-text-tertiary)' }}>Select an agent, or create one.</div>;

  const kpis = deriveKpis(runs);
  const recent = runs.slice(0, 24);

  async function toggleEnabled() {
    if (schedule) await api.updateSchedule(schedule.id, { enabled: !schedule.enabled });
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <StatusDot state={schedule.enabled ? 'idle' : 'disabled'} />
        <span style={{ fontSize: 20, fontWeight: 600 }}>{schedule.name}</span>
        <span style={{ font: '500 10px var(--font-mono)', letterSpacing: '0.4px', color: 'var(--color-text-secondary)', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 5, padding: '2px 6px' }}>{schedule.provider === 'claude-code' ? 'Claude Code' : 'Codex'}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => void api.runScheduleNow(schedule.id)} style={green}>Run now</button>
          <button onClick={onEdit} style={ghost}>Edit</button>
          <button onClick={() => void toggleEnabled()} style={ghost}>{schedule.enabled ? 'Disable' : 'Enable'}</button>
        </div>
      </div>
      <div style={{ color: 'var(--color-text-secondary)', fontSize: 12.5, margin: '8px 0 20px' }}>
        ◷ {summarize(schedule)}{schedule.nextRunAt ? ` · next ${new Date(schedule.nextRunAt).toLocaleString()}` : ''}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
        <Kpi label="Total Runs" value={String(kpis.totalRuns)} />
        <Kpi label="Success Rate" value={kpis.totalRuns ? `${Math.round(kpis.successRate * 100)}%` : '—'} accent />
        <Kpi label="Avg Duration" value={formatDuration(kpis.avgDurationMs)} />
      </div>

      <div style={panel}>
        <div style={label}>RUN HISTORY</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 80, marginTop: 12 }}>
          {recent.slice().reverse().map((r) => {
            const d = runDurationMs(r) ?? 0;
            const h = Math.max(6, Math.min(80, d / 1000));
            return <div key={r.id} title={`${r.status} · ${formatDuration(runDurationMs(r))}`} style={{ flex: 1, height: h, background: statusColor(r.status), borderRadius: 2, minWidth: 4 }} />;
          })}
          {!recent.length && <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12.5 }}>No runs yet</div>}
        </div>
      </div>

      <div style={{ ...panel, marginTop: 16 }}>
        <div style={label}>RECENT RUNS</div>
        {recent.map((r) => (
          <div key={r.id} style={{ display: 'flex', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--color-border)', fontSize: 12.5 }}>
            <span style={{ color: 'var(--color-text-secondary)', width: 160 }}>{r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}</span>
            <span style={{ width: 70, fontFamily: 'var(--font-mono)' }}>{formatDuration(runDurationMs(r))}</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, color: statusColor(r.status) }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor(r.status) }} />{r.status}
            </span>
          </div>
        ))}
        {!recent.length && <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12.5, padding: '8px 0' }}>No runs yet</div>}
      </div>

      <div style={{ ...panel, marginTop: 16 }}>
        <div style={label}>TRIGGER PROMPT</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.6, marginTop: 8, whiteSpace: 'pre-wrap', color: 'var(--color-text-secondary)' }}>{schedule.prompt}</div>
      </div>
    </div>
  );
}
