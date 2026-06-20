import { Play } from '@phosphor-icons/react';
import { api } from '../../api/client';
import { useAgents } from '../../stores/agents';
import { useIsMobile } from '../../hooks/useIsMobile';
import { deriveKpis, formatDuration, formatCost, formatTokens, runDurationMs, statusColor } from '../../lib/agentStats';
import { StatusDot } from '../common/StatusDot';
import type { AgentSchedule, AgentRun } from '../../api/types';

const panel: React.CSSProperties = { background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 12, padding: 14 };
const label: React.CSSProperties = { font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
const green: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 7, color: '#08240F', fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const ghost: React.CSSProperties = { height: 30, padding: '0 14px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-primary)', fontSize: 12, cursor: 'pointer' };
const kvRow: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 };
const kvVal: React.CSSProperties = { font: '400 11.5px var(--font-mono)', color: 'var(--color-text-secondary)' };

function summarize(s: AgentSchedule): string {
  if (s.scheduleKind === 'one-shot') return 'Manual / one-shot';
  try {
    const r = s.recurrenceRule ? JSON.parse(s.recurrenceRule) : null;
    if (r?.type === 'daily') return `Daily · ${r.time ?? ''}`;
    if (r?.type === 'interval' || r?.type === 'interval-minutes') { const m = Number(r.everyMinutes); return m % 60 === 0 ? `Every ${m / 60}h` : `Every ${m}m`; }
    if (r?.type === 'interval-hours') return `Every ${r.hours}h`;
    if (r?.type === 'weekly') { const n = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']; return `Weekly · ${(r.days ?? []).map((d: number) => n[d]).join(' ')} ${r.time ?? ''}`; }
    if (r?.type === 'cron') return `Cron · ${r.expr ?? ''}`;
    if (r?.type === 'manual') return 'Manual';
  } catch { /* ignore */ }
  return 'Recurring';
}

function cronExpr(s: AgentSchedule): string | null {
  try {
    const r = s.recurrenceRule ? JSON.parse(s.recurrenceRule) : null;
    return r?.type === 'cron' ? (r.expr ?? null) : null;
  } catch { return null; }
}

function Kpi({ label: l, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={panel}>
      <div style={label}>{l}</div>
      <div style={{ fontSize: 21, fontWeight: 600, marginTop: 6, color: accent ? 'var(--color-accent)' : 'var(--color-text-primary)' }}>{value}</div>
    </div>
  );
}

const LegendDot = ({ color, children }: { color: string; children: React.ReactNode }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
    <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />{children}
  </span>
);

export function AgentDashboard({ onEdit, onOpenRun, onBack }: { onEdit: () => void; onOpenRun: (runId: string) => void; onBack?: () => void }) {
  const schedule = useAgents((s) => s.schedules.find((x) => x.id === s.selectedId)) ?? null;
  const runs = useAgents((s) => s.runs);
  const isMobile = useIsMobile();

  if (!schedule) return <div style={{ flex: 1, padding: 24, color: 'var(--color-text-tertiary)' }}>Select an agent, or create one.</div>;

  const kpis = deriveKpis(runs);
  const recent = runs.slice(0, 24);
  const lastRun: AgentRun | undefined = runs[0];

  async function toggleEnabled() {
    if (schedule) await api.updateSchedule(schedule.id, { enabled: !schedule.enabled });
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: isMobile ? 14 : 24 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {onBack && <button onClick={onBack} title="Back" style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 16, padding: 0 }}>‹</button>}
        <StatusDot state={schedule.enabled ? 'idle' : 'disabled'} />
        <span style={{ fontSize: 20, fontWeight: 600 }}>{schedule.name}</span>
        <span style={{ font: '500 10px var(--font-mono)', letterSpacing: '0.4px', color: 'var(--color-text-secondary)', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 5, padding: '2px 6px' }}>{schedule.provider === 'claude-code' ? 'Claude Code' : 'Codex'}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => void api.runScheduleNow(schedule.id)} style={green}><Play size={13} weight="fill" /> Run now</button>
          <button onClick={onEdit} style={ghost}>Edit</button>
          <button onClick={() => void toggleEnabled()} style={ghost}>{schedule.enabled ? 'Disable' : 'Enable'}</button>
        </div>
      </div>
      <div style={{ color: 'var(--color-text-secondary)', fontSize: 12.5, margin: '8px 0 20px' }}>
        ◷ {summarize(schedule)}{schedule.nextRunAt ? ` · next ${new Date(schedule.nextRunAt).toLocaleString()}` : ''}
      </div>

      {/* KPI tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(5, 1fr)', gap: 12, marginBottom: 16 }}>
        <Kpi label="TOTAL RUNS" value={String(kpis.totalRuns)} />
        <Kpi label="SUCCESS RATE" value={kpis.totalRuns ? `${Math.round(kpis.successRate * 100)}%` : '—'} accent />
        <Kpi label="AVG DURATION" value={formatDuration(kpis.avgDurationMs || null)} />
        <Kpi label="AVG COST" value={formatCost(kpis.avgCost || null)} />
        <Kpi label="TOTAL COST · 30d" value={formatCost(kpis.totalCost30d)} />
      </div>

      {/* Run history chart */}
      <div style={panel}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={label}>RUN HISTORY · DURATION</div>
          <div style={{ display: 'flex', gap: 14, font: '400 11px var(--font-mono)', color: 'var(--color-text-secondary)' }}>
            <LegendDot color="var(--color-accent)">passed</LegendDot>
            <LegendDot color="var(--color-status-yellow)">running</LegendDot>
            <LegendDot color="var(--color-status-red)">failed</LegendDot>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 96, marginTop: 14 }}>
          {recent.slice().reverse().map((r) => {
            const d = runDurationMs(r) ?? 0;
            const h = Math.max(6, Math.min(96, (d / 1000) * 1.2));
            return <div key={r.id} title={`${r.status} · ${formatDuration(runDurationMs(r))} · ${formatCost(r.costUsd)}`} style={{ flex: 1, height: h, background: statusColor(r.status), borderRadius: '2px 2px 0 0', minWidth: 4 }} />;
          })}
          {!recent.length && <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12.5 }}>No runs yet</div>}
        </div>
        {!!recent.length && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, font: '400 10px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
            <span>{recent.length} runs ago</span><span>latest</span>
          </div>
        )}
      </div>

      {/* Bottom row: recent runs | (trigger + schedule) */}
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 16, marginTop: 16, alignItems: 'stretch' }}>
        {/* Recent runs */}
        <div style={{ ...panel, flex: 1.5, minWidth: 0 }}>
          <div style={label}>RECENT RUNS</div>
          {!isMobile && (
            <div style={{ display: 'flex', gap: 12, padding: '8px 0 6px', font: '500 9.5px var(--font-mono)', letterSpacing: '.6px', color: 'var(--color-text-tertiary)' }}>
              <span style={{ flex: 1.6 }}>STARTED</span><span style={{ flex: 1 }}>DURATION</span><span style={{ flex: 1 }}>COST</span><span style={{ flex: 1 }}>TOKENS</span><span style={{ flex: 1.4 }}>STATUS</span>
            </div>
          )}
          {recent.map((r) => isMobile ? (
            // Mobile: a 2-line card instead of the cramped 5-column table.
            <div key={r.id} onClick={() => onOpenRun(r.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 6px', margin: '0 -6px', borderTop: '1px solid var(--color-border)', cursor: 'pointer' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: statusColor(r.status), flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.startedAt ? new Date(r.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</div>
                <div style={{ font: '400 11.5px var(--font-mono)', color: 'var(--color-text-tertiary)', marginTop: 3 }}>{formatDuration(runDurationMs(r))} · {formatCost(r.costUsd)} · {formatTokens(r.totalTokens)}</div>
              </div>
              <span style={{ fontSize: 12.5, fontWeight: 500, color: statusColor(r.status), flexShrink: 0 }}>{r.status}</span>
            </div>
          ) : (
            <div key={r.id} onClick={() => onOpenRun(r.id)} title="Open run"
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 6px', margin: '0 -6px', borderTop: '1px solid var(--color-border)', font: '400 12px var(--font-mono)', cursor: 'pointer', borderRadius: 6 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
              <span style={{ flex: 1.6, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}</span>
              <span style={{ flex: 1, color: 'var(--color-text-secondary)' }}>{formatDuration(runDurationMs(r))}</span>
              <span style={{ flex: 1, color: 'var(--color-text-secondary)' }}>{formatCost(r.costUsd)}</span>
              <span style={{ flex: 1, color: 'var(--color-text-secondary)' }}>{formatTokens(r.totalTokens)}</span>
              <span style={{ flex: 1.4, display: 'inline-flex', alignItems: 'center', gap: 6, color: statusColor(r.status), minWidth: 0 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor(r.status), flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.status}</span>
              </span>
            </div>
          ))}
          {!recent.length && <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12.5, padding: '8px 0' }}>No runs yet</div>}
        </div>

        {/* Trigger + schedule */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={panel}>
            <div style={label}>TRIGGER PROMPT</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.6, marginTop: 8, whiteSpace: 'pre-wrap', color: 'var(--color-text-secondary)' }}>{schedule.prompt}</div>
          </div>
          <div style={panel}>
            <div style={{ ...label, marginBottom: 12 }}>SCHEDULE</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={kvRow}><span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>Frequency</span><span style={kvVal}>{summarize(schedule)}</span></div>
              <div style={kvRow}><span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>Cron</span><span style={kvVal}>{cronExpr(schedule) ?? '—'}</span></div>
              <div style={kvRow}><span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>Next run</span><span style={kvVal}>{schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : '—'}</span></div>
              <div style={kvRow}><span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>Last run</span>
                <span style={{ ...kvVal, display: 'inline-flex', alignItems: 'center', gap: 6, color: lastRun ? statusColor(lastRun.status) : 'var(--color-text-secondary)' }}>
                  {lastRun ? `${lastRun.startedAt ? new Date(lastRun.startedAt).toLocaleString() : '—'} · ${lastRun.status}` : '—'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
