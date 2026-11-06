// packages/core/src/limits/forecast.ts
// When will a limit run out at the current pace? (2026-11-05, the usage sheet's estimate.)
// The snapshot keeps only the latest figure, so this keeps a short history per provider and limit
// (one sample per SAMPLE_GAP_MS, KEEP_MS of them) and projects the recent pace forward.

/** [time ms, used percent 0-100, the window's reset time ms or null]. */
export type Sample = [number, number, number | null];
export type ProviderHistory = { account: string; windows: Record<string, Sample[]> };

export const SAMPLE_GAP_MS = 5 * 60_000;
export const KEEP_MS = 8 * 24 * 3600_000;
/** The pace is measured over this much of the recent past (the window's own start, if later). */
export const PACE_MS = 24 * 3600_000;
/** Less history than this is not a pace yet. */
export const MIN_SPAN_MS = 30 * 60_000;
/** Two reset times this close are the same window (providers round them differently). */
const SAME_RESET_MS = 5 * 60_000;

/**
 * Add a sample for each window with a figure. A new account starts over. Within SAMPLE_GAP_MS of
 * the last sample the last one is replaced, so a busy turn does not flood the history.
 */
export function addSamples(prior: ProviderHistory | undefined, account: string, windows: Record<string, { usedPercent: number | null; resetsAt: number | null }>, now: number): ProviderHistory {
  const out: ProviderHistory = prior && prior.account === account ? { account, windows: { ...prior.windows } } : { account, windows: {} };
  for (const [type, w] of Object.entries(windows)) {
    if (w.usedPercent === null) continue;
    const list = (out.windows[type] ?? []).filter((s) => s[0] >= now - KEEP_MS);
    const last = list[list.length - 1];
    const sample: Sample = [now, w.usedPercent, w.resetsAt];
    if (last && now - last[0] < SAMPLE_GAP_MS) list[list.length - 1] = sample; else list.push(sample);
    out.windows[type] = list;
  }
  return out;
}

export interface Forecast {
  /** When the limit would reach 100% at the recent pace; null when the pace is flat. */
  runsOutAt: number | null;
  /** True when, at that pace, the window resets first (or the pace is flat). */
  lastsUntilReset: boolean;
  /** Hours of history the pace was measured over (at most 24). */
  basisHours: number;
}

/**
 * The pace over the last PACE_MS of the CURRENT window (samples with this reset time), projected
 * to 100%. Null when there is not MIN_SPAN_MS of history in it yet, or the figure is unknown.
 */
export function forecast(samples: Sample[] | undefined, current: { usedPercent: number | null; resetsAt: number | null }, now: number): Forecast | null {
  if (!samples?.length || current.usedPercent === null) return null;
  if (current.resetsAt !== null && current.resetsAt <= now) return null;
  const sameWindow = (s: Sample) => current.resetsAt === null ? s[2] === null : s[2] !== null && Math.abs(s[2] - current.resetsAt) <= SAME_RESET_MS;
  const inRange = samples.filter((s) => s[0] >= now - PACE_MS && s[0] <= now && sameWindow(s));
  if (!inRange.length) return null;
  const first = inRange[0];
  const span = now - first[0];
  if (span < MIN_SPAN_MS) return null;
  const basisHours = Math.max(1, Math.round(span / 3600_000));
  const rate = (current.usedPercent - first[1]) / span; // percent per ms
  if (current.usedPercent >= 100) return { runsOutAt: now, lastsUntilReset: false, basisHours };
  if (rate <= 0) return { runsOutAt: null, lastsUntilReset: true, basisHours };
  const runsOutAt = Math.round(now + (100 - current.usedPercent) / rate);
  return { runsOutAt, lastsUntilReset: current.resetsAt !== null && runsOutAt >= current.resetsAt, basisHours };
}
