import { useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceArea, ResponsiveContainer, XAxis, YAxis,
} from 'recharts';
import { api } from '../../api/client';
import { useAnalyticsFeed } from '../../stores/analytics';
import { useIsMobile } from '../../hooks/useIsMobile';
import { OTHER, SERIES, resolveChartTheme } from './chartTheme';
import { Block, Kpi, NoData, chartTooltip, fmtDay, fmtSeconds, fmtTokens, labelStyle, muted } from './parts';
import type {
  AgentSeriesKey, ControlPlaneAnalytics as Payload, ControlPlaneProjectRow, MissionStatus,
} from '../../api/types';

/*
 * The Control Plane view of the Analytics screen
 * (docs/superpowers/specs/2026-09-29-control-plane-analytics-design.md, sections 3 and 6).
 * The shell (AnalyticsView) owns the filters; this view only fetches and draws.
 */

/** Spec 6.4: the agent-type series, in this order and these colors. */
const AGENT_SERIES: { key: AgentSeriesKey; color: string }[] = [
  { key: 'implementer', color: SERIES[0] },
  { key: 'researcher', color: SERIES[1] },
  { key: 'planner', color: SERIES[3] },
  { key: 'review', color: SERIES[2] },
];
/** Pink always means the Control Plane in this view. The other series in a pair is neutral. */
const CONTROL_PLANE = SERIES[4];
const NO_ACTIVITY = 'No Control Plane activity in this range.';
const NO_COMPLETIONS = 'No missions completed in this range.';
const COMPLETED_INFO = 'No working or queued agent, and no activity for 7 days.';

type Row = Record<string, string | number>;

/** Pivot the long series onto the continuous axes the daemon returns. */
function buildRows(data: Payload): { agents: Row[]; tokens: Row[]; messages: Row[]; weekly: Row[] } {
  const index = new Map(data.days.map((day, i) => [day, i]));
  const agents: Row[] = data.days.map((day) => ({ day }));
  for (const p of data.agentsByDay) {
    const i = index.get(p.day);
    if (i === undefined) continue;
    agents[i][p.key] = p.value;
    if (p.reviewGates !== undefined) agents[i].reviewGates = p.reviewGates;
  }
  const tokens: Row[] = data.days.map((day) => ({ day }));
  for (const p of data.tokensByDay) {
    const i = index.get(p.day);
    if (i !== undefined) tokens[i][p.key] = p.value;
  }
  // Lines need a point on every day, so a quiet day is a zero, not a gap.
  const messages: Row[] = data.days.map((day) => ({ day, you: 0, 'control-plane': 0 }));
  for (const p of data.messagesByDay) {
    const i = index.get(p.day);
    if (i !== undefined) messages[i][p.key] = p.value;
  }
  const byWeek = new Map(data.missionsCompletedByWeek.map((p) => [p.week, p.value]));
  const weekly: Row[] = data.weeks.map((week) => ({ week, value: byWeek.get(week) ?? 0 }));
  return { agents, tokens, messages, weekly };
}

const total = (points: { key: string; value: number }[], key: string) =>
  points.reduce((n, p) => (p.key === key ? n + p.value : n), 0);

/** The instant a local Monday week ends (the next Monday, local midnight), as ISO. */
function weekEnd(week: string): string {
  const [y, m, d] = week.split('-').map(Number);
  return new Date(y, m - 1, d + 7).toISOString();
}

const share = (cp: number, agents: number) => (cp + agents > 0 ? `${Math.round((100 * cp) / (cp + agents))}%` : '—');

const isActive = (r: ControlPlaneProjectRow) =>
  r.agents + r.activeDays + r.missionsStarted + r.missionsCompleted + r.controlPlaneTokens + r.agentTokens > 0;

export function ControlPlaneAnalytics({ from, projectId, provider }: { from?: string; projectId: string; provider: string }) {
  const isMobile = useIsMobile();
  // Recharts cannot read `var(--color-*)`, so the theme resolves to literals once.
  const theme = useMemo(() => resolveChartTheme(), []);
  // The same live signal as Usage: the daemon bumps it every time a turn closes.
  const rev = useAnalyticsFeed((s) => s.rev);
  const [data, setData] = useState<Payload | null>(null);
  const [trackingStartedAt, setTrackingStartedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [payload, tracking] = await Promise.all([
          api.analyticsControlPlane({
            ...(from ? { from } : {}), ...(projectId ? { projectId } : {}), ...(provider ? { provider } : {}),
          }),
          api.analyticsTracking(),
        ]);
        if (cancelled) return;
        setData(payload);
        setTrackingStartedAt(tracking.trackingStartedAt);
        setError(null);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [from, projectId, provider, rev]);

  const rows = useMemo(() => (data ? buildRows(data) : null), [data]);

  if (error && !data) return <div style={{ padding: '12px 0', color: 'var(--color-status-red)' }}>Analytics unavailable: {error}</div>;
  if (!data || !rows) return <div style={{ ...muted, padding: '12px 0' }}>Loading analytics…</div>;

  const { summary } = data;
  const tokenTotal = summary.controlPlaneTokens + summary.agentTokens;
  // Tokens exist only from the tracking start. Say so when the range reaches before it.
  const since = trackingStartedAt && (!from || from < trackingStartedAt)
    ? ` · since ${new Date(trackingStartedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
    : '';
  const settling = data.weeks.filter((week) => weekEnd(week) > data.settlingSince);

  const chartH = isMobile ? 200 : 240;
  const axisTick = { fill: theme.muted, fontSize: 11 };
  const legend = (
    <Legend
      formatter={(v: string) => <span style={{ color: theme.muted, fontSize: 11 }}>{v}</span>}
      wrapperStyle={{ paddingTop: 4 }}
    />
  );
  const pair: React.CSSProperties = { display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12, marginTop: 12 };
  const xDays = <XAxis dataKey="day" tickFormatter={fmtDay} tick={axisTick} tickLine={false} axisLine={{ stroke: theme.grid }} />;
  const grid = <CartesianGrid stroke={theme.grid} vertical={false} />;
  const margin = { top: 4, right: 8, left: 0, bottom: 0 };

  return (
    <>
      {error && <div style={{ ...muted, color: 'var(--color-status-red)', marginBottom: 12 }}>{error}</div>}

      {/* 1. KPI row — the same position as the Usage KPI row. */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(6, 1fr)', gap: 12 }}>
        <Kpi label="SESSIONS" value={summary.sessions.toLocaleString()} caption={`${summary.sessionsActive} active · ${summary.sessionsNew} new in range`} />
        <Kpi label="ACTIVE DAYS" value={summary.activeDays.toLocaleString()} caption="days with a Control Plane turn" />
        <Kpi label="MISSIONS STARTED" value={summary.missionsStarted.toLocaleString()} />
        <Kpi label="MISSIONS COMPLETED" value={summary.missionsCompleted.toLocaleString()} info={COMPLETED_INFO} />
        <Kpi label="AGENTS STARTED" value={summary.agentsStarted.toLocaleString()} />
        <Kpi
          label="CONTROL PLANE TOKEN SHARE"
          value={tokenTotal > 0 ? share(summary.controlPlaneTokens, summary.agentTokens) : '—'}
          caption={tokenTotal > 0
            ? `${fmtTokens(summary.controlPlaneTokens)} of ${fmtTokens(tokenTotal)} Control Plane and agent tokens${since}`
            : `no recorded tokens${since}`}
        />
      </div>

      {/* 2. Agents started per day, by type. */}
      <div style={{ marginTop: 16 }}>
        <Block title="AGENTS STARTED PER DAY · BY TYPE" note="review includes design-reviewer and code-reviewer">
          {data.agentsByDay.length === 0 ? <NoData height={chartH} message={NO_ACTIVITY} /> : (
            <ResponsiveContainer width="100%" height={chartH} minHeight={chartH}>
              <BarChart data={rows.agents} margin={margin}>
                {grid}
                {xDays}
                <YAxis allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} width={36} />
                {chartTooltip(theme, (v, name, item) => [
                  name === 'review' ? `${Number(v)} (${Number(item?.payload?.reviewGates ?? 0)} gates)` : String(v),
                  String(name),
                ])}
                {legend}
                {AGENT_SERIES.map((s) => (
                  <Bar
                    key={s.key} dataKey={s.key} name={s.key} stackId="agents" fill={s.color}
                    stroke={theme.surface} strokeWidth={2} radius={[4, 4, 0, 0]} isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </Block>
      </div>

      {/* 3. Tokens and messages. Pink is the Control Plane in both. */}
      <div style={pair}>
        <Block title="TOKENS PER DAY · CONTROL PLANE VS AGENTS">
          {data.tokensByDay.length === 0 ? <NoData height={chartH} message={NO_ACTIVITY} /> : (
            <ResponsiveContainer width="100%" height={chartH} minHeight={chartH}>
              <BarChart data={rows.tokens} margin={margin}>
                {grid}
                {xDays}
                <YAxis tickFormatter={fmtTokens} tick={axisTick} tickLine={false} axisLine={false} width={48} />
                {chartTooltip(theme, (v, name) => [fmtTokens(Number(v)), String(name)])}
                {legend}
                <Bar dataKey="agents" name="Agents" stackId="tokens" fill={OTHER} stroke={theme.surface} strokeWidth={2} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="control-plane" name="Control Plane" stackId="tokens" fill={CONTROL_PLANE} stroke={theme.surface} strokeWidth={2} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Block>
        <Block
          title="MESSAGES PER DAY"
          note={`${total(data.messagesByDay, 'you').toLocaleString()} from you · ${total(data.messagesByDay, 'control-plane').toLocaleString()} to agents`}
        >
          {data.messagesByDay.length === 0 ? <NoData height={chartH} message={NO_ACTIVITY} /> : (
            <ResponsiveContainer width="100%" height={chartH} minHeight={chartH}>
              <LineChart data={rows.messages} margin={margin}>
                {grid}
                {xDays}
                <YAxis allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} width={36} />
                {chartTooltip(theme)}
                {legend}
                <Line type="monotone" dataKey="you" name="You → Control Plane" stroke={OTHER} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="control-plane" name="Control Plane → agents" stroke={CONTROL_PLANE} strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Block>
      </div>

      {/* 4. Missions completed per week, and the project table. */}
      <div style={pair}>
        <Block title="MISSIONS COMPLETED PER WEEK" note="weeks start on Monday">
          {data.missionsCompletedByWeek.length === 0 ? <NoData height={chartH} message={NO_COMPLETIONS} /> : (
            <ResponsiveContainer width="100%" height={chartH} minHeight={chartH}>
              <BarChart data={rows.weekly} margin={margin}>
                <defs>
                  <pattern id="cp-settling" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <rect width="2" height="6" fill={theme.grid} />
                  </pattern>
                </defs>
                {grid}
                <XAxis dataKey="week" tickFormatter={fmtDay} tick={axisTick} tickLine={false} axisLine={{ stroke: theme.grid }} />
                <YAxis allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} width={36} />
                {chartTooltip(theme, (v) => [String(v), 'missions completed'])}
                {settling.length > 0 && (
                  <ReferenceArea
                    x1={settling[0]} x2={settling[settling.length - 1]} fill="url(#cp-settling)" fillOpacity={1} stroke="none"
                    label={{ value: 'still settling · 7-day idle rule', position: 'insideTop', fill: theme.muted, fontSize: 10 }}
                  />
                )}
                {/* One series, named by the title. Pink: a mission is the Control Plane's unit of work. */}
                <Bar dataKey="value" name="missions completed" fill={CONTROL_PLANE} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Block>
        <Block title="BY PROJECT">
          <ProjectTable rows={data.byProject} />
        </Block>
      </div>

      {/* 5. By agent type. */}
      <div style={{ marginTop: 12 }}>
        <Block title="BY AGENT TYPE">
          {data.byType.length === 0 ? <NoData height={60} message={NO_ACTIVITY} /> : (
            <Table
              head={['Type', 'Agents', 'Avg turn', 'Tokens', 'CLI mix']}
              align={['left', 'right', 'right', 'right', 'left']}
              rows={data.byType.map((t) => [
                t.agentType,
                t.agents.toLocaleString(),
                t.avgTurnSeconds == null ? '—' : fmtSeconds(t.avgTurnSeconds),
                fmtTokens(t.tokens),
                Object.entries(t.cli).sort((a, b) => b[1] - a[1]).map(([cli, n]) => `${cli} ${n}`).join(' · '),
              ])}
            />
          )}
        </Block>
      </div>

      {/* 6. Missions active in the range. */}
      <div style={{ marginTop: 12 }}>
        <Block title="MISSIONS · ACTIVE IN RANGE" note="values cover the whole mission">
          {data.missions.length === 0 ? <NoData height={60} message={NO_ACTIVITY} /> : (
            <Table
              head={['Mission', 'Project', 'Agents', 'Review gates', 'Length', 'Status']}
              align={['left', 'left', 'right', 'right', 'right', 'left']}
              rows={data.missions.map((m) => [
                m.mission,
                m.projectName,
                m.agents.toLocaleString(),
                m.reviewGates.toLocaleString(),
                `${m.lengthDays} ${m.lengthDays === 1 ? 'day' : 'days'}`,
                <StatusChip key="status" status={m.status} />,
              ])}
            />
          )}
        </Block>
      </div>
    </>
  );
}

/** The active projects, then one muted footer row for the rest, so the sessions still add up. */
function ProjectTable({ rows }: { rows: ControlPlaneProjectRow[] }) {
  if (rows.length === 0) return <NoData height={60} message={NO_ACTIVITY} />;
  const active = rows.filter(isActive);
  const idle = rows.filter((r) => !isActive(r));
  const idleSessions = idle.reduce((n, r) => n + r.sessions, 0);
  return (
    <Table
      head={['Project', 'Sessions', 'Active days', 'Started in range', 'Completed in range', 'Agents', 'CP token share']}
      align={['left', 'right', 'right', 'right', 'right', 'right', 'right']}
      rows={active.map((r) => [
        r.name, r.sessions.toLocaleString(), r.activeDays.toLocaleString(), r.missionsStarted.toLocaleString(),
        r.missionsCompleted.toLocaleString(), r.agents.toLocaleString(), share(r.controlPlaneTokens, r.agentTokens),
      ])}
      footer={idle.length > 0
        ? `${idle.length} more ${idle.length === 1 ? 'project' : 'projects'} · ${idleSessions} ${idleSessions === 1 ? 'session' : 'sessions'} · no activity in range`
        : undefined}
    />
  );
}

function Table({ head, align, rows, footer }: {
  head: string[]; align: ('left' | 'right')[]; rows: React.ReactNode[][]; footer?: string;
}) {
  const cell: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--color-border)', whiteSpace: 'nowrap', fontSize: 12.5 };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', color: 'var(--color-text-primary)' }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} style={{ ...cell, ...labelStyle, textAlign: align[i], fontWeight: 500 }}>{h.toUpperCase()}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, i) => (
                <td key={i} style={{ ...cell, textAlign: align[i], fontFamily: align[i] === 'right' ? 'var(--font-mono)' : undefined }}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {footer && <div style={{ ...muted, padding: '8px 10px' }}>{footer}</div>}
    </div>
  );
}

/** Status as text and a shape, never color alone. */
function StatusChip({ status }: { status: MissionStatus }) {
  const done = status === 'completed';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--color-border)', borderRadius: 999,
      padding: '1px 8px', fontSize: 11, color: done ? 'var(--color-text-secondary)' : 'var(--color-text-primary)',
    }}>
      <span aria-hidden="true">{done ? '✓' : '○'}</span>
      <span>{done ? 'Completed' : 'Active'}</span>
    </span>
  );
}
