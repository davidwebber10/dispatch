import type { AgentRun } from '../api/types';

export interface Kpis {
  totalRuns: number;
  successRate: number;   // 0..1 over finished runs
  avgDurationMs: number;
  avgCost: number;       // mean cost over runs that recorded a cost
  totalCost30d: number;  // sum of costs in the last 30 days
  totalTokens: number;   // sum of tokens over all runs
}

const TERMINAL = ['succeeded', 'failed', 'cancelled'];
const DAY_MS = 24 * 60 * 60 * 1000;

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

  const costs = runs.map((r) => r.costUsd).filter((c): c is number => c != null);
  const avgCost = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;

  const cutoff = Date.now() - 30 * DAY_MS;
  const totalCost30d = runs.reduce((sum, r) => {
    const t = r.completedAt ?? r.startedAt;
    if (r.costUsd != null && t && Date.parse(t) >= cutoff) return sum + r.costUsd;
    return sum;
  }, 0);

  const totalTokens = runs.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);

  return {
    totalRuns: runs.length,
    successRate: finished.length ? succeeded / finished.length : 0,
    avgDurationMs: avg,
    avgCost,
    totalCost30d,
    totalTokens,
  };
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1000) return n.toLocaleString();
  return String(n);
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
