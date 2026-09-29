# Control Plane analytics — design

Date: 2026-09-29. Status: approved design, not built.

Related files:
- `2026-09-29-control-plane-analytics-mockup-brief.md`: the brief sent to Claude Design (tokens, palette, real data).
- `2026-09-29-control-plane-analytics-mockups.html`: the Claude Design mockups. Open it in a browser. Variant 1 is the approved layout.

## 1. Goal

Add Control Plane metrics to the Analytics screen: sessions, missions, agents, review gates,
the Control Plane's share of tokens, and messages. Show them by project.

The Analytics screen is one pane today. This feature makes it two views of one screen. The change
must be clear: the user always knows which view is on screen, and the filters behave the same in
both views.

## 2. Decisions

| Decision | Choice |
|---|---|
| Metric scope | Volume, cost, flow, and the message counts (items 1–9 of the candidate list). Escalations to the user and user stops are out: Dispatch does not record them yet. Scheduled role runs are out: there are too few. |
| Completed mission | Rule B, the idle rule (section 4). An explicit finished status is follow-up work (section 11). |
| Control Plane session | A coordinator thread, archived rows included. "Active days" is shown next to it. |
| Layout | Variant 1: a view switch `Usage \| Control Plane` in the title row. |
| Changes to the Usage view | None in this feature. The top-4 model fold and the continuous day axis go in a separate PR (section 11). |

## 3. Layout (Variant 1)

- A segmented control `Usage | Control Plane` sits beside the "Analytics" title. On mobile, it sits
  under the title and spans the full width. It reads as one screen with two views, not as document
  tabs.
- The filter row (Project, Range, Provider) is the same in both views: the same controls, in the
  same place, with the same values. A change of view never moves or resets a filter. The filter
  state moves up from `AnalyticsView` to a parent that both views share.
- The title, the switch, the filters, and the KPI row sit at the same pixels in both views.
- The screen remembers the last view in `localStorage` (key `dispatch:analytics-view`). A first
  visit opens Usage.
- Mobile: the bottom tab label changes from "Usage" to "Analytics".
- The Control Plane view uses the same parts as Usage: `Kpi` tiles, `Block` panels, the chart
  theme, the tooltip style, and the number formatters. Shared parts move out of
  `AnalyticsView.tsx` into a small module so that both views import them.

Control Plane view, top to bottom:

1. KPI row, 6 tiles (section 6.1).
2. `AGENTS STARTED PER DAY · BY TYPE`, full width.
3. `TOKENS PER DAY · CONTROL PLANE VS AGENTS` and `MESSAGES PER DAY`, side by side on desktop.
4. `MISSIONS COMPLETED PER WEEK` and `BY PROJECT`, side by side on desktop.
5. `BY AGENT TYPE`, full width.
6. `MISSIONS · ACTIVE IN RANGE`, full width.

On mobile, every block is full width, in the same order.

## 4. Definitions

One core module owns these definitions (section 7). No other file repeats them.

- **Coordinator:** a `terminals` row with `config.role = 'coordinator'`. Archived rows count.
- **Session:** one coordinator row. "New session…" archives the old row and creates a new one, so
  each new session adds one row.
- **Agent:** a `terminals` row with `config.role = 'agent'` and no `config.roleRun`. Scheduled role
  runs are not Control Plane agents, so they are excluded.
- **Agent last activity:** the latest of `created_at`, `last_activity_at`, and `archived_at`.
- **Mission:** the pair (`session_id`, `config.mission`). Agents with no mission (the "General"
  group) are not in any mission metric.
- **Mission first activity:** the earliest `created_at` of its agents.
- **Mission last activity:** the latest agent last activity of its agents.
- **Completed mission (rule B):** no agent of the mission has status `working` or `queued`, and
  the mission last activity is more than 7 days before now. The completion time is the mission last
  activity. One function, `missionState()`, holds this rule, so an explicit status can replace it
  later without a change to any caller.
- **Active mission:** a mission that is not completed.
- **Review gate:** an agent with `agentType` `design-reviewer` or `code-reviewer`.
- **Agent type series:** `implementer`, `researcher`, `planner`, and `review`. The `review` series
  holds `reviewer`, `design-reviewer`, and `code-reviewer`. Its tooltip shows the review gates
  separately.
- **Days:** local days, the same as Usage (`date(x, 'localtime')`).
- **Weeks:** local weeks that start on Monday.

## 5. Filters

All filters are server-side, the same as Usage. `from` and `to` bound a half-open interval.

| Filter | Effect in the Control Plane view |
|---|---|
| Range (`from`, `to`) | Each metric uses the time of its own event (section 6). |
| Project (`projectId`) | Keeps rows whose `session_id` is the project. |
| Provider (`provider`) | Keeps threads whose `terminals.type` (the CLI) is the provider: coordinators for the session metrics, agents for the agent metrics, and `usage_turns.provider` for the token metrics. A mission stays when at least one of its agents runs on that CLI. Its state still uses all of its agents. |

## 6. Metrics

### 6.1 KPI row

| Tile | Value | Caption |
|---|---|---|
| SESSIONS | Coordinators that existed in the range: `created_at < to` and (`archived_at` is null or `archived_at >= from`). | "`A` active · `N` new in range". `A` = coordinators with at least one `usage_turns` row in the range. `N` = coordinators created in the range. |
| ACTIVE DAYS | Distinct local days with a coordinator turn (`usage_turns.role = 'coordinator'`) in the range. | "days with a Control Plane turn" |
| MISSIONS STARTED | Missions whose first activity is in the range. | — |
| MISSIONS COMPLETED | Completed missions whose completion time is in the range. | Info icon. Tooltip: "No working or queued agent, and no activity for 7 days." |
| AGENTS STARTED | Agents created in the range. | — |
| CONTROL PLANE TOKEN SHARE | Coordinator tokens ÷ (coordinator + agent tokens), from `usage_turns` in the range. | "`X` of `Y` Control Plane and agent tokens" |

A token total is input + output + cache read + cache create, the same as Usage.

### 6.2 Charts

| Block | Form | Data |
|---|---|---|
| AGENTS STARTED PER DAY · BY TYPE | Stacked columns, 4 series | Agents created per local day, by agent type series. |
| TOKENS PER DAY · CONTROL PLANE VS AGENTS | Stacked columns, 2 series | Token totals per local day, for `usage_turns.role` `coordinator` and `agent`. |
| MESSAGES PER DAY | 2 lines | "You → Control Plane": `message_source.source = 'user'` on a coordinator thread. "Control Plane → agents": `message_source.source = 'coordinator'` on an agent thread (not a role run), which includes the task that starts each agent. `message_thread` also tags peer messages `coordinator`, so the agent check is what scopes this series. The Project and Provider filters use the thread that receives the message. The caption shows the two totals. The view shows no average. |
| MISSIONS COMPLETED PER WEEK | Columns, 1 series | Completed missions per local week, by completion time. A week that overlaps the last 7 days gets a hatched band labeled "still settling · 7-day idle rule", because rule B cannot complete a mission in that time yet. |

All four charts use a continuous day or week axis. A day with no data is an empty column or a
zero point, not a skipped label.

### 6.3 Tables

**BY PROJECT.** One row for each project with a session in the range or any activity in the range. Columns: Project, Sessions,
Active days, Started in range, Completed in range, Agents, CP token share. The rows with activity
in the range come first, ordered by agents. The other rows fold into one muted footer row, for
example "10 more projects · 10 sessions · no activity in range". The sessions column adds up to the
SESSIONS tile.

**BY AGENT TYPE.** One row for each `agentType` of the agents created in the range. Columns: Type,
Agents, Avg turn, Tokens, CLI mix (for example "codex 19 · claude-code 11"). Avg turn is the mean
`usage_turns.duration_ms` of those agents' turns in the range. It shows "—" when there are no
turns with a duration.

**MISSIONS · ACTIVE IN RANGE.** Missions with any agent created, or any agent last activity, in the
range. The newest last activity comes first. The limit is 50 rows. Columns: Mission, Project,
Agents, Review gates, Length, Status. The values describe the whole mission, not only the range.
Length is the number of local days from the first activity to the last activity, inclusive. Status
is a chip with text and an icon: a ring for Active, a check for Completed.

### 6.4 Colors

The view uses the existing validated palette in `chartTheme.ts`. It adds no new hue.

- Agent type series, in this order: implementer `#3987e5`, researcher `#d95926`, planner
  `#c98500`, review `#199e70`.
- `#d55181` always means the Control Plane: the Control Plane series in the tokens chart, and
  "Control Plane → agents" in the messages chart.
- The other series in those two charts ("Agents", "You → Control Plane") use the neutral
  `#6b6b73`.
- `MISSIONS COMPLETED PER WEEK` is one series. It uses the Control Plane pink, because a mission
  is the Control Plane's unit of work. Blue would read as "implementer".
- Status colors are never a series color.

## 7. Architecture

### Core

- **New file `packages/core/src/analytics/control-plane.ts`.** It holds pure query functions over
  `better-sqlite3`, the definitions in section 4, and `missionState()`. It uses bound parameters
  only, the same as `queries.ts`.
- **One function, `controlPlaneAnalytics(db, range)`,** returns the whole payload:

```ts
interface ControlPlaneAnalytics {
  days: string[];  // every local day in the range, oldest first: the continuous chart axis
  weeks: string[]; // every local Monday in the range, oldest first
  summary: {
    sessions: number; sessionsActive: number; sessionsNew: number;
    activeDays: number; missionsStarted: number; missionsCompleted: number;
    agentsStarted: number; controlPlaneTokens: number; agentTokens: number;
  };
  agentsByDay: { day: string; key: 'implementer' | 'researcher' | 'planner' | 'review'; value: number; reviewGates?: number }[];
  tokensByDay: { day: string; key: 'control-plane' | 'agents'; value: number }[];
  messagesByDay: { day: string; key: 'you' | 'control-plane'; value: number }[];
  missionsCompletedByWeek: { week: string; value: number }[]; // week = local Monday, YYYY-MM-DD
  settlingSince: string; // now − 7 days (ISO); the UI hatches weeks that overlap it
  byProject: {
    projectId: string; name: string; sessions: number; activeDays: number;
    missionsStarted: number; missionsCompleted: number; agents: number;
    controlPlaneTokens: number; agentTokens: number;
  }[];
  byType: { agentType: string; agents: number; avgTurnSeconds: number | null; tokens: number; cli: Record<string, number> }[];
  missions: {
    projectId: string; projectName: string; mission: string; agents: number; reviewGates: number;
    firstAt: string; lastAt: string; lengthDays: number; status: 'active' | 'completed';
  }[];
}
```

- **Coordinators, agents, and missions are computed in TypeScript** from one `terminals` scan per
  request (about 1,300 rows). `config` is parsed with `JSON.parse`, the same as the rest of core.
  This keeps rule B in one function instead of in several SQL strings. The token, day, and message
  sums stay in SQL.
- **The payload types** live in `packages/core/src/analytics/control-plane-types.ts`, a file with
  no imports. The web client re-exports them from `api/types.ts`, so the two sides cannot drift.
- **New route: `GET /api/analytics/control-plane`** in `routes/analytics.ts`. It takes the same
  `from`, `to`, `projectId`, and `provider` parameters and the same parse as the other routes.
- **Size:** the data is about 1,200 agent rows and a few thousand turns. One request per refresh is
  enough. No new index or table is needed.

### Web

- **New `packages/web/src/components/analytics/ControlPlaneAnalytics.tsx`:** the Control Plane view.
- **New `packages/web/src/components/analytics/parts.tsx`:** `Kpi`, `Block`, `NoData`, the tooltip,
  and the formatters, moved out of `AnalyticsView.tsx` without a change in behavior.
- **`AnalyticsView.tsx`** keeps the header, the switch, and the filter state. It shows either the
  Usage content (the current body) or the Control Plane content.
- **New `api.analyticsControlPlane(range)`** and a `ControlPlaneAnalytics` type in `api/types.ts`.
- **Live refresh:** the Control Plane view fetches again when `useAnalyticsFeed.rev` changes, the
  same as Usage. Only the visible view fetches.
- **Mobile:** `MobileApp.tsx` renames the bottom tab label to "Analytics".

## 8. States

- **Loading:** "Loading analytics…", the same as Usage.
- **Error:** the same red message as Usage.
- **No Control Plane activity in the range:** the KPI row still shows (sessions exist). Each chart
  shows `NoData` with the text "No Control Plane activity in this range."
- **Token metrics before 2026-08-15:** the token share tile and the token chart use only recorded
  turns. When the range has no start ("All time") or starts before the tracking start, the tile
  caption adds "since" and the tracking date, for example "since Aug 15, 2026". The date comes from
  the existing `/tracking` route.

## 9. Testing

Core, with an in-memory DB and seeded rows (`packages/core/src/analytics/control-plane.test.ts`):

- An archived coordinator counts as a session. A coordinator archived before the range does not.
- `sessionsActive` and `sessionsNew` follow their definitions.
- A role-run agent (`config.roleRun`) is never counted.
- Rule B: a mission idle for more than 7 days is completed. One idle for less than 7 days is
  active. A `working` or `queued` agent keeps it active. A new agent opens it again.
- The completion time is the mission last activity, and the week bucket starts on Monday, local
  time.
- Started in range and completed in range count separate events (a mission started before the
  range can complete in it).
- The Provider filter on sessions, agents, tokens, and missions.
- The `review` series counts `reviewer` and both review gate types. `reviewGates` counts only the
  gates.
- The token share uses `usage_turns.role` only.
- Messages: "you" counts only `source = 'user'` on coordinator threads.
- The missions table: the range, the order, and the 50-row limit.

Route (`routes/analytics.test.ts`): the payload shape, and each filter parameter reaches the query.
The route has no enum parameter, so it has no 400 case.

Web (`ControlPlaneAnalytics.test.tsx`, `AnalyticsView.test.tsx`):

- The switch changes the view and keeps the filter values.
- The stored view is read back. A first visit opens Usage.
- The KPI tiles and captions render from a fixture payload.
- The by-project footer row adds up the inactive projects.
- The status chip shows text, not only color.

## 10. Known limits

- Rule B needs 7 idle days, so recent completions show late. The chart marks this.
- The token metrics start at the analytics tracking start (2026-08-15 on this Mac). The message
  metrics start on 2026-07-02. Sessions, missions, and agents have data from June.
- A mission name typed two ways ("Delta sync" and "Delta Sync") counts as two missions.
- The messages chart covers Claude Code threads only. Only the Claude structured manager records
  message sources today; Codex and Grok threads record none, so a Codex filter shows zero messages.
  The block note says so. Recording sources for the other harnesses is follow-up work.
- An archive stamps `archived_at`, which counts as agent activity. A user who archives old agent
  threads long after their work ended opens those missions again, and they complete 7 days later
  as a group. On 2026-09-29, 11 of 715 archived agents on the owner's Mac were archived more than
  7 days after their last activity, so the effect is small. Removing `archived_at` from the rule
  would hurt the 56 archived agents that have no `last_activity_at`.
- An archived project's threads are deleted, so its sessions, missions, and agents leave the
  Control Plane view. "Archived rows count" applies to archived threads, not archived projects.

## 11. Follow-up work (not in this feature)

- **An explicit finished status for missions.** For example, a `complete_mission` tool for the
  coordinator and a UI control. `missionState()` then prefers the explicit status and falls back to
  rule B.
- **Usage view fixes, in a separate PR:**
  - Fold "tokens by model" to the top 4 models plus "Other". The top 4 must come from all-time
    totals, so that a filter never changes the color of a model.
  - Use a continuous day axis.
- **Escalations and stops:** record the questions that agents send up to the user, and record the
  agents that the user stops, so that a later version can count them.
