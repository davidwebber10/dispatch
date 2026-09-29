import { Tooltip } from 'recharts';

/*
 * The parts both Analytics views share: styles, number and day formatters, the KPI tile, the
 * block panel, the empty state, and the one tooltip style. Moved out of AnalyticsView.tsx so the
 * Usage and Control Plane views cannot drift apart.
 */

/* ------------------------------------------------------------------ styles */

export const panel: React.CSSProperties = {
  background: 'var(--color-elevated)', border: '1px solid var(--color-border)',
  borderRadius: 12, padding: 14, minWidth: 0,
};
export const labelStyle: React.CSSProperties = {
  font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)',
};
export const inputStyle: React.CSSProperties = {
  height: 28, padding: '0 8px', background: 'var(--color-elevated)',
  border: '1px solid var(--color-border)', borderRadius: 7,
  color: 'var(--color-text-primary)', fontSize: 12,
};
export const muted: React.CSSProperties = { color: 'var(--color-text-tertiary)', fontSize: 12.5 };

/* ------------------------------------------------------------- formatting */

const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  return n < 1000 ? String(n) : COMPACT.format(n);
}

export function fmtSeconds(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtDay(iso: string): string {
  // 'YYYY-MM-DD' from the query layer, already bucketed in local time.
  return iso.length >= 10 ? iso.slice(5) : iso;
}

export function localDayString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function startOfLocalDay(daysAgo: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

/** Empty model/outcome keys are real rows with an unknown key, not missing rows. */
export function normKey(k: string): string { return k === '' ? 'unknown' : k; }

/* ------------------------------------------------------------- small parts */

export type ChartTheme = { text: string; muted: string; grid: string; surface: string };

/**
 * A KPI tile. `caption` adds a line under the value; `info` adds a mark in the label row whose
 * title and accessible name carry the text. With neither, the DOM is exactly the old tile.
 */
export function Kpi({ label, value, title, badge, badgeTitle, caption, info }: {
  label: string; value: string; title?: string; badge?: string; badgeTitle?: string; caption?: string; info?: string;
}) {
  return (
    <div style={panel} title={title}>
      <div style={labelStyle}>
        {label}
        {info && <span aria-label={info} title={info} style={{ float: 'right', cursor: 'help', letterSpacing: 0 }}>ⓘ</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
        <span style={{ fontSize: 21, fontWeight: 600, color: 'var(--color-text-primary)' }}>{value}</span>
        {badge && (
          <span
            title={badgeTitle}
            style={{
              font: '500 9.5px var(--font-mono)', letterSpacing: '.6px', color: 'var(--color-text-tertiary)',
              border: '1px solid var(--color-border)', borderRadius: 5, padding: '1px 5px', cursor: 'help',
            }}
          >{badge}</span>
        )}
      </div>
      {caption && <div style={{ ...muted, fontSize: 11.5, marginTop: 4 }}>{caption}</div>}
    </div>
  );
}

export function Block({ title, note, children, style }: {
  title: string; note?: string; children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <div style={{ ...panel, ...style }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div style={labelStyle}>{title}</div>
        {note && <div style={{ font: '400 10px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{note}</div>}
      </div>
      <div style={{ marginTop: 12 }}>{children}</div>
    </div>
  );
}

export function NoData({ height, message = 'No turns in this range.' }: { height: number; message?: string }) {
  return <div style={{ ...muted, height, display: 'flex', alignItems: 'center' }}>{message}</div>;
}

/**
 * One tooltip, styled once. Every chart gets a tooltip; only the value formatter differs. The
 * formatter's third argument is the hovered item, whose `payload` is the chart row.
 */
export function chartTooltip(
  theme: ChartTheme,
  formatter?: (v: unknown, name: unknown, item?: { payload?: Record<string, unknown> }) => [string, string],
) {
  return (
    <Tooltip
      cursor={{ fill: 'rgba(255,255,255,0.04)' }}
      contentStyle={{ background: theme.surface, border: `1px solid ${theme.grid}`, borderRadius: 8, fontSize: 12 }}
      labelStyle={{ color: theme.muted }}
      itemStyle={{ color: theme.text }}
      formatter={formatter as never}
    />
  );
}
