import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api } from '../../api/client';
import { useAnalyticsFeed } from '../../stores/analytics';
import { useProjects } from '../../stores/projects';
import { useIsMobile } from '../../hooks/useIsMobile';
import { makeSeriesScale, OUTCOME_COLOR, OTHER, SERIES, resolveChartTheme } from './chartTheme';
import type {
  AnalyticsBackfillState, AnalyticsPoint, AnalyticsRecords, AnalyticsSummary, AnalyticsTopRow,
} from '../../api/types';

/* ------------------------------------------------------------------ styles */

const panel: React.CSSProperties = {
  background: 'var(--color-elevated)', border: '1px solid var(--color-border)',
  borderRadius: 12, padding: 14, minWidth: 0,
};
const labelStyle: React.CSSProperties = {
  font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)',
};
const inputStyle: React.CSSProperties = {
  height: 28, padding: '0 8px', background: 'var(--color-elevated)',
  border: '1px solid var(--color-border)', borderRadius: 7,
  color: 'var(--color-text-primary)', fontSize: 12,
};
const ghost: React.CSSProperties = {
  height: 30, padding: '0 14px', background: 'var(--color-elevated)',
  border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-primary)',
  fontSize: 12, cursor: 'pointer',
};
const muted: React.CSSProperties = { color: 'var(--color-text-tertiary)', fontSize: 12.5 };

/* ------------------------------------------------------------- formatting */

const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  return n < 1000 ? String(n) : COMPACT.format(n);
}

/**
 * The notional figure. Dispatch runs on a subscription, so no dollars change
 * hands per turn — this is what the same tokens would have been worth at API
 * list prices. The label the user reads says exactly that.
 */
function fmtNotional(usd: number | null | undefined): string {
  if (usd == null) return '—';
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function fmtSeconds(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtDay(iso: string): string {
  // 'YYYY-MM-DD' from the query layer, already bucketed in local time.
  return iso.length >= 10 ? iso.slice(5) : iso;
}

function localDayString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function startOfLocalDay(daysAgo: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

/** Empty model/outcome keys are real rows with an unknown key, not missing rows. */
function normKey(k: string): string { return k === '' ? 'unknown' : k; }

/* ------------------------------------------------------------------- data */

type RangeId = '7' | '30' | '90' | 'all';
const RANGES: { id: RangeId; label: string; days: number | null }[] = [
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: '90', label: 'Last 90 days', days: 90 },
  { id: 'all', label: 'All time', days: null },
];

const CALENDAR_WEEKS = 26;
const CALENDAR_DAYS = CALENDAR_WEEKS * 7;

/** The heatmap ramp: one hue, monotonic lightness, near-surface to full accent. */
const HEAT = ['#1B1B1E', '#1E3D28', '#256B3C', '#2E9C52', '#3ECF6A'];

/** Everything a filter changes. Re-fetched whenever a select moves. */
interface Loaded {
  summary: AnalyticsSummary;
  tokensByModel: AnalyticsPoint[];
  /** Fetched WITHOUT the provider filter, so the select can always offer every
   * provider in the range — a filtered list would strand the reader on one. */
  providerOptions: AnalyticsPoint[];
  outputTotal: AnalyticsPoint[];
  turnsByOutcome: AnalyticsPoint[];
  duration: AnalyticsPoint[];
  calendar: AnalyticsPoint[];
  topModels: AnalyticsTopRow[];
  topProjects: AnalyticsTopRow[];
}

/**
 * The COLOUR DOMAINS: every key the table has ever held, fetched with no range,
 * no project and no provider.
 *
 * A domain built from filtered data would shrink when a filter shrinks, the scale
 * would rebuild over the survivors, and picking one provider would repaint the
 * models that remain. That is the exact defect `makeSeriesScale` exists to
 * prevent, one layer up: a stable function over a moving domain is still unstable.
 */
interface Domain {
  modelKeys: string[];
  projectKeys: string[];
}

/** The two routes that take no range at all, so no filter can change them. */
interface Stats {
  records: AnalyticsRecords;
  backfill: AnalyticsBackfillState;
}

/**
 * Pivot the long series the daemon returns into the wide rows Recharts wants:
 * one row per day, one column per key. The key list comes back sorted, so the
 * caller can hand it straight to `makeSeriesScale` as a colour domain.
 */
function pivot(points: AnalyticsPoint[], keyOf: (p: AnalyticsPoint) => string): { rows: Record<string, string | number>[]; keys: string[] } {
  const byDay = new Map<string, Record<string, string | number>>();
  const keys = new Set<string>();
  for (const p of points) {
    const k = keyOf(p);
    keys.add(k);
    let row = byDay.get(p.day);
    if (!row) { row = { day: p.day }; byDay.set(p.day, row); }
    row[k] = (Number(row[k]) || 0) + p.value;
  }
  const rows = [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  return { rows, keys: [...keys].sort() };
}

/**
 * The first cell of the heatmap: the Sunday on or before the start of the
 * window, so every column is a whole week. The fetch starts here too — a cell
 * the grid draws must be a day the query covered, or a busy day outside the
 * window would read as a quiet one.
 */
function calendarStart(): Date {
  const d = startOfLocalDay(CALENDAR_DAYS - 1);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

/* ------------------------------------------------------------- small parts */

function Kpi({ label, value, title, badge, badgeTitle }: {
  label: string; value: string; title?: string; badge?: string; badgeTitle?: string;
}) {
  return (
    <div style={panel} title={title}>
      <div style={labelStyle}>{label}</div>
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
    </div>
  );
}

function Block({ title, note, children, style }: {
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

function NoData({ height, message = 'No turns in this range.' }: { height: number; message?: string }) {
  return <div style={{ ...muted, height, display: 'flex', alignItems: 'center' }}>{message}</div>;
}

/**
 * One tooltip, styled once. Every chart gets a tooltip; only the value formatter
 * differs, so that is the only thing this takes.
 */
function chartTooltip(
  theme: { text: string; muted: string; grid: string; surface: string },
  formatter?: (v: unknown, name: unknown) => [string, string],
) {
  return (
    <Tooltip
      cursor={{ fill: 'rgba(255,255,255,0.04)' }}
      contentStyle={{ background: theme.surface, border: `1px solid ${theme.grid}`, borderRadius: 8, fontSize: 12 }}
      labelStyle={{ color: theme.muted }}
      itemStyle={{ color: theme.text }}
      formatter={formatter}
    />
  );
}

/* -------------------------------------------------------------- the view */

export function AnalyticsView() {
  const isMobile = useIsMobile();
  const sessions = useProjects((s) => s.sessions);
  // Recharts cannot read `var(--color-*)`, so the theme resolves to literals once.
  const theme = useMemo(() => resolveChartTheme(), []);

  const [rangeId, setRangeId] = useState<RangeId>('30');
  const [projectId, setProjectId] = useState('');
  const [provider, setProvider] = useState('');
  const [data, setData] = useState<Loaded | null>(null);
  const [domain, setDomain] = useState<Domain | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [reload, setReload] = useState(0);
  // The daemon bumps this through the single events socket every time a turn
  // closes, so an open page follows the work. No timer, no polling.
  const rev = useAnalyticsFeed((s) => s.rev);

  const days = RANGES.find((r) => r.id === rangeId)?.days ?? null;
  const from = days == null ? undefined : startOfLocalDay(days - 1).toISOString();

  // The colour domains. Fetched once per mount, and deliberately NOT on `rev`:
  // these are whole-table queries, and re-pulling them on every closed turn would
  // cost far more than it buys. A model first seen mid-session therefore wears
  // OTHER until the page is opened again — a stable grey, which is the property
  // that matters. Nothing here may ever shrink with a filter.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [modelPoints, projectPoints] = await Promise.all([
          api.analyticsSeries({ metric: 'tokens', groupBy: 'model' }),
          api.analyticsSeries({ metric: 'tokens', groupBy: 'project' }),
        ]);
        if (cancelled) return;
        setDomain({
          modelKeys: [...new Set(modelPoints.map((p) => normKey(p.key)))],
          projectKeys: [...new Set(projectPoints.map((p) => p.key))],
        });
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [reload]);

  // The range-less routes. They follow the live revision — an all-time record can
  // fall at any moment — but no select can change them, so they sit outside the
  // filtered batch instead of re-requesting on every select change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [records, backfill] = await Promise.all([api.analyticsRecords(), api.analyticsBackfillState()]);
        if (!cancelled) setStats({ records, backfill });
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [reload, rev]);

  useEffect(() => {
    let cancelled = false;
    // Every filter is a server-side filter: the daemon binds `provider` as a SQL
    // parameter on summary, series and top alike, so no block derives a filtered
    // number for itself.
    const scope = { ...(from ? { from } : {}), ...(projectId ? { projectId } : {}) };
    const range = { ...scope, ...(provider ? { provider } : {}) };
    const calendarRange = { from: calendarStart().toISOString(), ...(projectId ? { projectId } : {}), ...(provider ? { provider } : {}) };
    (async () => {
      try {
        const [
          summary, tokensByModel, providerOptions, outputTotal, turnsByOutcome,
          duration, calendar, topModels, topProjects,
        ] = await Promise.all([
          api.analyticsSummary(range),
          api.analyticsSeries({ ...range, metric: 'tokens', groupBy: 'model' }),
          api.analyticsSeries({ ...scope, metric: 'tokens', groupBy: 'provider' }),
          api.analyticsSeries({ ...range, metric: 'outputTokens', groupBy: 'none' }),
          api.analyticsSeries({ ...range, metric: 'turns', groupBy: 'outcome' }),
          api.analyticsSeries({ ...range, metric: 'duration', groupBy: 'none' }),
          api.analyticsSeries({ ...calendarRange, metric: 'tokens', groupBy: 'none' }),
          api.analyticsTop({ ...range, dimension: 'model' }),
          api.analyticsTop({ ...range, dimension: 'project' }),
        ]);
        if (cancelled) return;
        setData({
          summary, tokensByModel, providerOptions, outputTotal, turnsByOutcome,
          duration, calendar, topModels, topProjects,
        });
        setError(null);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [from, projectId, provider, reload, rev]);

  const runImport = useCallback(async () => {
    setImporting(true);
    try { await api.analyticsRunBackfill(); setReload((n) => n + 1); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setImporting(false); }
  }, []);

  /*
   * Undo an import. It deletes ONLY rows with backfilled = 1; a measured turn is
   * never touched. Destructive, so it is never a single click — `confirmRemove`
   * gates it behind a second, explicit press.
   */
  const removeImport = useCallback(async () => {
    setRemoving(true);
    try { await api.analyticsClearBackfill(); setConfirmRemove(false); setReload((n) => n + 1); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setRemoving(false); }
  }, []);

  /*
   * ONE scale per dimension, built from the UNFILTERED domain — every key the
   * table has ever held — and then reused by every block and every filtered view.
   *
   * The domain comes from `base`, which no select can touch. Sourcing it from the
   * filtered data instead would let a filter shrink the domain, rebuild the scale
   * over the survivors, and repaint them: pick one provider and the models that
   * remain would change colour. A ranked table is worse still, because it is
   * truncated as well as filtered.
   *
   * The price is that a wide domain pushes more keys past SERIES.length into
   * OTHER. That is the right trade: a stable grey beats a series that changes
   * colour when you touch a filter.
   */
  const modelScale = useMemo(() => makeSeriesScale(domain?.modelKeys ?? []), [domain?.modelKeys]);
  const projectScale = useMemo(() => makeSeriesScale(domain?.projectKeys ?? []), [domain?.projectKeys]);

  const providerDomain = useMemo(
    () => [...new Set((data?.providerOptions ?? []).map((p) => normKey(p.key)))].sort(),
    [data?.providerOptions],
  );

  const tokensChart = useMemo(
    () => (data ? pivot(data.tokensByModel, (p) => normKey(p.key)) : { rows: [], keys: [] }),
    [data],
  );

  const outputChart = useMemo(
    () => (data ? pivot(data.outputTotal, () => 'output') : { rows: [], keys: [] }),
    [data],
  );

  const outcomeChart = useMemo(
    () => (data ? pivot(data.turnsByOutcome, (p) => normKey(p.key)) : { rows: [], keys: [] }),
    [data],
  );

  const durationChart = useMemo(
    () => (data ? pivot(data.duration, () => 'seconds') : { rows: [], keys: [] }),
    [data],
  );

  const calendarCells = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const p of data?.calendar ?? []) byDay.set(p.day, (byDay.get(p.day) ?? 0) + p.value);
    const max = Math.max(0, ...byDay.values());
    const cells: { day: string; value: number; color: string }[] = [];
    const cursor = calendarStart();
    const today = localDayString(new Date());
    for (let i = 0; ; i += 1) {
      const day = localDayString(cursor);
      if (day > today) break;
      const value = byDay.get(day) ?? 0;
      const t = max > 0 ? value / max : 0;
      const idx = t <= 0.05 ? 0 : t <= 0.25 ? 1 : t <= 0.5 ? 2 : t <= 0.75 ? 3 : 4;
      cells.push({ day, value, color: value > 0 ? HEAT[idx] : theme.surface });
      cursor.setDate(cursor.getDate() + 1);
      if (i > 400) break;
    }
    return cells;
  }, [data?.calendar, theme.surface]);

  if (error && (!data || !domain || !stats)) {
    return <div style={{ flex: 1, padding: 24, color: 'var(--color-status-red)' }}>Analytics unavailable: {error}</div>;
  }
  if (!data || !domain || !stats) {
    return <div style={{ flex: 1, padding: 24, ...muted }}>Loading analytics…</div>;
  }

  const { summary } = data;
  const { records, backfill } = stats;
  const trackingDate = backfill.trackingStartedAt
    ? new Date(backfill.trackingStartedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : 'recently';
  const filtered = Boolean(projectId) || Boolean(provider) || rangeId !== '30';
  const isEmpty = summary.turns === 0;

  const unreported = Number(summary.unreportedTurns ?? 0);
  const imported = Number(summary.backfilledTurns ?? 0);
  /*
   * Every turn in this range closed without a usage frame. The token totals are
   * then not a measurement of zero — they are the absence of one, and a "0" would
   * claim work that used nothing. Show '—' and let the sentence below explain.
   * This is the shape a PTY-ish provider takes once the filter reaches the daemon.
   */
  const nothingReported = summary.turns > 0 && unreported >= summary.turns;
  const noUsageTitle = 'No usage was ever reported for these turns, so there is nothing to count. This is not a measured zero.';

  /*
   * Undoing an import. The count is the ALL-TIME one from /backfill, not the
   * range-scoped figure, so a reader looking at the last 7 days can still remove
   * an import of much older history.
   *
   * Two presses, always: an import changes what TURNS counts, and a control that
   * destroys rows on one click is a trap. The confirm step names the number.
   */
  const importedAllTime = Number(backfill.backfilledTurns ?? 0);
  const removeControl = importedAllTime > 0 && (
    confirmRemove ? (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={muted}>Remove {importedAllTime.toLocaleString()} imported {importedAllTime === 1 ? 'row' : 'rows'}? Measured turns are kept.</span>
        <button onClick={() => void removeImport()} disabled={removing} style={{ ...ghost, color: 'var(--color-status-red)' }}>
          {removing ? 'Removing…' : 'Remove'}
        </button>
        <button onClick={() => setConfirmRemove(false)} disabled={removing} style={ghost}>Cancel</button>
      </div>
    ) : (
      <button onClick={() => setConfirmRemove(true)} style={ghost}>Remove imported history</button>
    )
  );

  const chartH = isMobile ? 200 : 240;
  const axisTick = { fill: theme.muted, fontSize: 11 };
  const tokenTooltip = chartTooltip(theme, (v, name) => [fmtTokens(Number(v)), String(name)]);
  const legend = (
    <Legend
      formatter={(v: string) => <span style={{ color: theme.muted, fontSize: 11 }}>{v}</span>}
      wrapperStyle={{ paddingTop: 4 }}
    />
  );

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: isMobile ? 14 : 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 20, fontWeight: 600 }}>Analytics</span>
        <span style={{ ...muted, font: '400 11px var(--font-mono)' }}>days are local time</span>
      </div>

      {/* 1. Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0 16px' }}>
        <select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={inputStyle}>
          <option value="">All projects</option>
          {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select aria-label="Range" value={rangeId} onChange={(e) => setRangeId(e.target.value as RangeId)} style={inputStyle}>
          {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)} style={inputStyle}>
          <option value="">All providers</option>
          {providerDomain.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {error && <div style={{ ...muted, color: 'var(--color-status-red)', marginBottom: 12 }}>{error}</div>}

      {isEmpty ? (
        <div style={{ ...panel, padding: 24 }}>
          <div style={{ fontSize: 15, color: 'var(--color-text-primary)' }}>
            {filtered
              ? `No turns match these filters — analytics started ${trackingDate}.`
              : `No turns recorded yet — analytics started ${trackingDate}.`}
          </div>
          <div style={{ ...muted, marginTop: 8, maxWidth: 620 }}>
            Dispatch records one row per turn as you work. Everything before that date is missing
            until you import it.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
            <button onClick={() => void runImport()} disabled={importing} style={ghost}>
              {importing ? 'Importing history…' : 'Import history'}
            </button>
            {removeControl}
          </div>
        </div>
      ) : (
        <>
          {/* 2. Headline totals */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(5, 1fr)', gap: 12 }}>
            <Kpi label="TOTAL TOKENS" value={nothingReported ? '—' : fmtTokens(summary.totalTokens)} title={nothingReported ? noUsageTitle : undefined} />
            <Kpi label="OUTPUT TOKENS" value={nothingReported ? '—' : fmtTokens(summary.outputTokens)} title={nothingReported ? noUsageTitle : undefined} />
            {/* An imported row is one assistant MESSAGE, not one turn — the transcript
                records no turn boundaries. So once history is imported this count mixes
                two units, and the badge says so instead of letting the reader assume. */}
            <Kpi
              label="TURNS"
              value={summary.turns.toLocaleString()}
              badge={imported > 0 ? `includes ${imported.toLocaleString()} imported` : undefined}
              badgeTitle="Imported history has no turn boundaries, so each imported row is one assistant message, not one turn. Their tokens are counted normally."
            />
            <Kpi label="THREADS" value={summary.threads.toLocaleString()} />
            <Kpi
              label="EQUIVALENT API VALUE"
              value={nothingReported ? '—' : fmtNotional(summary.notionalUsd)}
              title={nothingReported ? noUsageTitle : 'What these tokens would be worth at API list prices. Dispatch runs on a subscription, so this is a notional figure, not a bill.'}
              badge={!nothingReported && summary.unpricedTokens > 0 ? 'partial' : undefined}
              badgeTitle={`${fmtTokens(summary.unpricedTokens)} tokens came from a model with no price entry, so they are counted in the token totals but not in this value.`}
            />
          </div>

          {/* Turns whose usage was never reported. NOT a measured zero. */}
          {unreported > 0 && (
            <div style={{ ...muted, marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--color-text-secondary)' }}>{unreported} {unreported === 1 ? 'turn' : 'turns'} reported no usage</span>
              <span>
                — no usage frame ever arrived for them, so their tokens are missing from the totals
                above. They are not turns that used nothing.
              </span>
            </div>
          )}

          {/* A `title` is hover-only, and a touch device has no hover, so on mobile
              the partial marker's reason is rendered as a line the reader can see. */}
          {isMobile && !nothingReported && summary.unpricedTokens > 0 && (
            <div style={{ ...muted, marginTop: 10 }}>
              The value above is partial: {fmtTokens(summary.unpricedTokens)} tokens came from a model
              with no price entry, so they are counted in the token totals but not in that figure.
            </div>
          )}

          {/* 3. Tokens over time */}
          <div style={{ marginTop: 16 }}>
            {/* One series carries its identity in the title, which is the only
                reason the legend may be dropped — so the title names the model. */}
            <Block title={tokensChart.keys.length === 1 ? `TOKENS OVER TIME · ${tokensChart.keys[0].toUpperCase()}` : 'TOKENS OVER TIME · BY MODEL'}>
              {tokensChart.rows.length === 0 ? <NoData height={chartH} /> : (
                <ResponsiveContainer width="100%" height={chartH} minHeight={chartH}>
                  <BarChart data={tokensChart.rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={theme.grid} vertical={false} />
                    <XAxis dataKey="day" tickFormatter={fmtDay} tick={axisTick} tickLine={false} axisLine={{ stroke: theme.grid }} />
                    <YAxis tickFormatter={fmtTokens} tick={axisTick} tickLine={false} axisLine={false} width={48} />
                    {tokenTooltip}
                    {tokensChart.keys.length > 1 && legend}
                    {tokensChart.keys.map((k) => (
                      <Bar
                        key={k} dataKey={k} stackId="tokens" fill={modelScale(k)}
                        stroke={theme.surface} strokeWidth={2} radius={[4, 4, 0, 0]}
                        isAnimationActive={false}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Block>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12, marginTop: 12 }}>
            {/* 4. Output tokens over time — its own chart, never a second axis on the one above.
                The single-series charts share one accent hue; their titles name the measure. */}
            <Block title="OUTPUT TOKENS OVER TIME">
              {outputChart.rows.length === 0 ? <NoData height={chartH} /> : (
                <ResponsiveContainer width="100%" height={chartH} minHeight={chartH}>
                  <LineChart data={outputChart.rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={theme.grid} vertical={false} />
                    <XAxis dataKey="day" tickFormatter={fmtDay} tick={axisTick} tickLine={false} axisLine={{ stroke: theme.grid }} />
                    <YAxis tickFormatter={fmtTokens} tick={axisTick} tickLine={false} axisLine={false} width={48} />
                    {tokenTooltip}
                    {/* One series, so the title names it and no legend is needed. */}
                    <Line type="monotone" dataKey="output" name="output tokens" stroke={SERIES[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Block>

            {/* 5. Turns per day by outcome — the one chart that wears status colours. */}
            <Block title="TURNS PER DAY · BY OUTCOME">
              {outcomeChart.rows.length === 0 ? <NoData height={chartH} /> : (
                <ResponsiveContainer width="100%" height={chartH} minHeight={chartH}>
                  <BarChart data={outcomeChart.rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={theme.grid} vertical={false} />
                    <XAxis dataKey="day" tickFormatter={fmtDay} tick={axisTick} tickLine={false} axisLine={{ stroke: theme.grid }} />
                    <YAxis allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} width={36} />
                    {chartTooltip(theme)}
                    {outcomeChart.keys.length > 1 && legend}
                    {outcomeChart.keys.map((k) => (
                      <Bar
                        key={k} dataKey={k} stackId="turns" fill={OUTCOME_COLOR[k] ?? OTHER}
                        stroke={theme.surface} strokeWidth={2} radius={[4, 4, 0, 0]}
                        isAnimationActive={false}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Block>
          </div>

          {/*
            * 6. Turn duration. Seconds share no scale with tokens or with turn
            * counts, so this is a chart of its own and never a second axis on one
            * of the charts above. The query layer already drops zero-length rows,
            * so a restart-interrupted turn cannot pull the mean toward zero.
            */}
          <div style={{ marginTop: 12 }}>
            <Block title="AVG TURN DURATION · SECONDS" note="mean per day, interrupted turns excluded">
              {durationChart.rows.length === 0 ? <NoData height={chartH} message="No durations recorded in this range." /> : (
                <ResponsiveContainer width="100%" height={chartH} minHeight={chartH}>
                  <BarChart data={durationChart.rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={theme.grid} vertical={false} />
                    <XAxis dataKey="day" tickFormatter={fmtDay} tick={axisTick} tickLine={false} axisLine={{ stroke: theme.grid }} />
                    <YAxis tickFormatter={(v: number) => fmtSeconds(v)} tick={axisTick} tickLine={false} axisLine={false} width={48} />
                    {chartTooltip(theme, (v) => [fmtSeconds(Number(v)), 'avg turn'])}
                    {/* One series, so the title names it and no legend is needed. */}
                    <Bar dataKey="seconds" name="avg turn duration" fill={SERIES[0]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Block>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12, marginTop: 12 }}>
            {/* 7. Ranked bars — length, not angle. Never a pie. */}
            <Block title="MODEL MIX · TOKENS">
              <RankedBars
                rows={data.topModels.map((r) => ({ ...r, key: normKey(r.key), label: normKey(r.label) }))}
                color={modelScale} theme={theme} height={chartH}
              />
            </Block>
            <Block title="TOP PROJECTS · TOKENS">
              <RankedBars rows={data.topProjects} color={projectScale} theme={theme} height={chartH} />
            </Block>
          </div>

          {/* 8. Activity calendar */}
          <div style={{ marginTop: 12 }}>
            <Block title={`ACTIVITY · LAST ${CALENDAR_WEEKS} WEEKS`} note="tokens per day">
              <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
                <div style={{
                  display: 'grid', gridTemplateRows: 'repeat(7, 11px)', gridAutoFlow: 'column',
                  gridAutoColumns: '11px', gap: 3, width: 'max-content',
                }}>
                  {calendarCells.map((c) => (
                    <div
                      key={c.day}
                      data-day={c.day}
                      title={c.value > 0 ? `${c.day} · ${fmtTokens(c.value)} tokens` : ''}
                      style={{
                        width: 11, height: 11, borderRadius: 3, background: c.color,
                        border: c.value > 0 ? 'none' : `1px solid ${theme.grid}`, boxSizing: 'border-box',
                      }}
                    />
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, ...muted }}>
                <span style={{ font: '400 10px var(--font-mono)' }}>less</span>
                {HEAT.map((c) => <span key={c} style={{ width: 11, height: 11, borderRadius: 3, background: c }} />)}
                <span style={{ font: '400 10px var(--font-mono)' }}>more</span>
              </div>
            </Block>
          </div>

          {/* 10. History import */}
          <div style={{ ...panel, marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={labelStyle}>HISTORY</div>
              <div style={{ ...muted, marginTop: 6 }}>
                Analytics started {trackingDate}. Import reads the transcripts of older threads once;
                it never touches a measured turn.
                {backfill.state === 'running' && ` Importing ${backfill.done}/${backfill.total}…`}
                {backfill.state === 'error' && ` Last import failed: ${backfill.error ?? 'unknown error'}`}
                {backfill.state === 'done' && backfill.lastFinishedAt && ` Last imported ${new Date(backfill.lastFinishedAt).toLocaleString()}.`}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button onClick={() => void runImport()} disabled={importing || backfill.state === 'running'} style={ghost}>
                {importing ? 'Importing history…' : 'Import history'}
              </button>
              {removeControl}
            </div>
          </div>
        </>
      )}

      {/*
        * 9. Personal records — facts, not trends. Rendered OUTSIDE the empty
        * branch: /api/analytics/records takes no range, so a quiet 30 days would
        * otherwise hide a reader's all-time facts behind an empty state that is
        * only true of the filtered window. It is hidden only when there is
        * genuinely nothing recorded at all, where a list of zeroes would be the
        * same lie the empty state exists to avoid.
        */}
      {records.totalTurns > 0 && (
        <div style={{ marginTop: 12 }}>
          <Block title="PERSONAL RECORDS · ALL TIME" note="every project, every provider — the filters above do not apply">
            <div style={{
              display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)',
              gap: '8px 24px',
            }}>
              <Record label="Tokens" value={`${fmtTokens(records.totalTokens)} tokens`} />
              <Record label="Turns" value={`${records.totalTurns.toLocaleString()} turns`} />
              <Record label="Active days" value={`${records.activeDays.toLocaleString()} days`} />
              <Record label="Busiest day" value={records.busiestDay ? `${records.busiestDay} · ${fmtTokens(records.busiestDayTokens)} tokens` : '—'} />
              <Record label="Most-used model" value={records.topModel ? normKey(records.topModel) : '—'} />
              <Record label="Longest turn" value={records.longestTurnSeconds > 0 ? fmtSeconds(records.longestTurnSeconds) : '—'} />
            </div>
          </Block>
        </div>
      )}
    </div>
  );
}

function Record({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, borderBottom: '1px solid var(--color-border)', padding: '6px 0' }}>
      <span style={{ ...muted }}>{label}</span>
      <span style={{ font: '400 11.5px var(--font-mono)', color: 'var(--color-text-secondary)' }}>{value}</span>
    </div>
  );
}

/**
 * A ranked horizontal bar. Compared by length, never by angle — and each row
 * takes its colour from the shared scale, so a model keeps its hue here and in
 * the time series.
 */
function RankedBars({ rows, color, theme, height }: {
  rows: AnalyticsTopRow[];
  color: (key: string) => string;
  theme: { text: string; muted: string; grid: string; surface: string };
  height: number;
}) {
  if (rows.length === 0) return <NoData height={height} />;
  return (
    <ResponsiveContainer width="100%" height={Math.max(height, rows.length * 26)} minHeight={height}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={theme.grid} horizontal={false} />
        <XAxis type="number" tickFormatter={fmtTokens} tick={{ fill: theme.muted, fontSize: 11 }} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="label" width={116} tick={{ fill: theme.muted, fontSize: 11 }} tickLine={false} axisLine={false} />
        {chartTooltip(theme, (v) => [fmtTokens(Number(v)), 'tokens'])}
        <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={14} isAnimationActive={false}>
          {rows.map((r) => <Cell key={r.key} fill={color(r.key)} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
