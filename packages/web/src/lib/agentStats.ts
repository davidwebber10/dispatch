import type { AgentRun } from '../api/types';

export interface Kpis {
  totalRuns: number;
  successRate: number;   // 0..1 over finished runs
  avgDurationMs: number;
}

const TERMINAL = ['succeeded', 'failed', 'cancelled'];

export function runDurationMs(run: AgentRun): number | null {
  if (!run.startedAt || !run.completedAt) return null;
  const d = Date.parse(run.completedAt) - Date.parse(run.startedAt);
  return d >= 0 ? d : null;
}

export function deriveKpis(runs: AgentRun[]): Kpis {
  const finished = runs.filter((r) => TERMINAL.includes(r.status));
  const succeeded = runs.filter((r) => r.status === 'succeeded').length;
  const durations = runs.map(runDurationMs).filter((d): d is number => d != null);
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  return {
    totalRuns: runs.length,
    successRate: finished.length ? succeeded / finished.length : 0,
    avgDurationMs: avg,
  };
}

export function formatDuration(ms: number | null): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

export function statusColor(status: string): string {
  if (status === 'succeeded') return 'var(--color-accent)';
  if (status === 'failed') return 'var(--color-status-red)';
  if (status === 'cancelled') return 'var(--color-text-tertiary)';
  if (status === 'needs_input') return 'var(--color-status-yellow)';
  return 'var(--color-status-yellow)'; // working/queued/starting/idle
}
