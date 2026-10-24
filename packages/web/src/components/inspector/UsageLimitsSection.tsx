import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { limitRows, type LimitRows } from './usageLimits';

/**
 * The thread's usage limits, ready to show (null until the first answer or when the fetch fails).
 * Shared by the desktop Details pane and the Context window popup. Refetches when the thread or
 * `refreshKey` changes, and once a minute so "resets" and "as of" never sit stale.
 */
export function useUsageLimits(terminalId: string | null | undefined, refreshKey = ''): LimitRows | null {
  const [rows, setRows] = useState<LimitRows | null>(null);
  useEffect(() => {
    setRows(null); // never keep the previous thread's figures while (or if) the new fetch fails
    if (!terminalId) return;
    let live = true;
    const load = () => api.getUsageLimits(terminalId).then((l) => { if (live) setRows(limitRows(l, Date.now())); }).catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => { live = false; clearInterval(timer); };
  }, [terminalId, refreshKey]);
  return rows;
}

/** The pause line, the limit rows and the "As of" line. `row` draws one label/value row in the host's style. */
export function UsageLimitsRows({ lim, row, asOfStyle }: { lim: LimitRows; row: (label: string, value: string) => ReactNode; asOfStyle?: React.CSSProperties }) {
  return (
    <div data-testid="usage-limits">
      {lim.paused && <div style={{ padding: '3px 0', fontSize: 13, color: 'var(--color-text-primary)' }}>{lim.paused}</div>}
      {lim.rows.map((r) => <div key={r.label}>{row(r.label, r.value)}</div>)}
      {lim.asOf && <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', textAlign: 'right', ...asOfStyle }}>{lim.asOf}</div>}
    </div>
  );
}
