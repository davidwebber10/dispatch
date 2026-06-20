import { useEffect, useState } from 'react';
import { CaretRight, ArrowClockwise } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { AgentOverview, AgentOverviewAgent, TerminalType } from '../../api/types';
import { providerColor } from '../common/typeIcons';
import { timeAgo } from '../../lib/time';
import { Spinner } from '../common/Spinner';

const money = (n: number) => '$' + (n > 0 && n < 1 ? n.toFixed(3) : n.toFixed(2));

function statusOf(a: AgentOverviewAgent): { label: string; color: string; pulse: boolean } {
  if (a.running) return { label: 'Running', color: 'var(--color-accent)', pulse: true };
  if (!a.enabled) return { label: 'Off', color: 'var(--color-text-tertiary)', pulse: false };
  if (a.nextRunAt) return { label: 'Scheduled', color: 'var(--color-status-yellow)', pulse: false };
  return { label: 'Idle', color: 'var(--color-text-secondary)', pulse: false };
}

/**
 * Cross-project "Agents" tab: every agent grouped by project with its live status
 * and all-time spend, plus grand totals. Data is the SQL rollup from
 * GET /api/agents/overview; load failures degrade gracefully (a server that
 * predates the endpoint just shows a retry).
 */
export function AllAgentsView({ onOpenAgent }: { onOpenAgent: (projectId: string, scheduleId: string) => void }) {
  const [data, setData] = useState<AgentOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = () => {
    setLoading(true); setError(false);
    api.agentsOverview().then((d) => { setData(d); setLoading(false); }).catch(() => { setError(true); setLoading(false); });
  };
  useEffect(load, []);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 8, padding: '10px 12px', flexShrink: 0 }}>
        <Stat label="AGENTS" value={data ? String(data.agentCount) : '—'} />
        <Stat label="RUNNING" value={data ? String(data.runningCount) : '—'} accent={!!data?.runningCount} />
        <Stat label="SPEND" value={data ? money(data.totalSpendUsd) : '—'} />
        <button onClick={load} title="Refresh" style={{ flexShrink: 0, width: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 12, color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
          <ArrowClockwise size={17} weight="bold" />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', padding: '0 4px 12px' }}>
        {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={24} /></div>}
        {error && !loading && <Empty text="Couldn't load agents — the server may need updating." onRetry={load} />}
        {data && !loading && !error && data.projects.length === 0 && <Empty text="No agents yet." />}
        {data && !loading && !error && data.projects.map((proj) => (
          <div key={proj.projectId} style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '12px 12px 6px' }}>
              <span style={{ font: '700 13px var(--font-mono)', letterSpacing: '1.1px', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(proj.projectName ?? 'Unknown').toUpperCase()}</span>
              <span style={{ marginLeft: 'auto', flexShrink: 0, font: '600 12px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{money(proj.spendUsd)}</span>
            </div>
            {proj.agents.map((a) => {
              const st = statusOf(a);
              const meta = [st.label, a.lastRunAt ? timeAgo(a.lastRunAt) : null, a.runCount ? `${a.runCount} run${a.runCount === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
              return (
                <button key={a.scheduleId} onClick={() => onOpenAgent(proj.projectId, a.scheduleId)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '13px 12px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--color-border)', cursor: 'pointer' }}>
                  <span style={{ width: 11, height: 11, borderRadius: '50%', flexShrink: 0, background: st.pulse ? st.color : providerColor(a.provider as TerminalType), animation: st.pulse ? 'dispatchPulse 1.6s ease-in-out infinite' : undefined }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</div>
                    <div style={{ marginTop: 2, fontSize: 12.5, color: st.color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta}</div>
                  </div>
                  <span style={{ flexShrink: 0, font: '600 14px var(--font-mono)', color: a.spendUsd > 0 ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }}>{money(a.spendUsd)}</span>
                  <CaretRight size={16} color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ flex: 1, minWidth: 0, background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 12, padding: '8px 10px' }}>
      <div style={{ font: '600 9.5px var(--font-mono)', letterSpacing: '0.8px', color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div style={{ marginTop: 3, fontSize: 18, fontWeight: 600, color: accent ? 'var(--color-accent)' : 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );
}

function Empty({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div style={{ padding: 36, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13.5 }}>
      {text}
      {onRetry && (
        <div style={{ marginTop: 12 }}>
          <button onClick={onRetry} style={{ padding: '8px 16px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 10, color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 13 }}>Retry</button>
        </div>
      )}
    </div>
  );
}
