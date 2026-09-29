/**
 * The Control Plane analytics payload: GET /api/analytics/control-plane.
 *
 * Types only, with no imports, so the web client imports this file directly
 * (packages/web/src/api/types.ts re-exports it) and the two sides cannot drift.
 */

export type AgentSeriesKey = 'implementer' | 'researcher' | 'planner' | 'review';
export type MissionStatus = 'active' | 'completed';

export interface ControlPlaneSummary {
  /** Coordinator threads that existed at any time in the range (archived ones included). */
  sessions: number;
  /** Coordinator threads with at least one turn in the range. */
  sessionsActive: number;
  /** Coordinator threads created in the range. */
  sessionsNew: number;
  /** Local days with at least one coordinator turn in the range. */
  activeDays: number;
  missionsStarted: number;
  missionsCompleted: number;
  agentsStarted: number;
  controlPlaneTokens: number;
  agentTokens: number;
}

export interface ControlPlaneProjectRow {
  projectId: string;
  name: string;
  sessions: number;
  activeDays: number;
  missionsStarted: number;
  missionsCompleted: number;
  agents: number;
  controlPlaneTokens: number;
  agentTokens: number;
}

export interface ControlPlaneTypeRow {
  agentType: string;
  agents: number;
  avgTurnSeconds: number | null;
  tokens: number;
  /** Agents per CLI, for example { codex: 19, 'claude-code': 11 }. */
  cli: Record<string, number>;
}

export interface ControlPlaneMissionRow {
  projectId: string;
  projectName: string;
  mission: string;
  agents: number;
  reviewGates: number;
  firstAt: string;
  lastAt: string;
  lengthDays: number;
  status: MissionStatus;
}

export interface ControlPlaneAnalytics {
  summary: ControlPlaneSummary;
  /** Every local day (YYYY-MM-DD) in the range, oldest first: the continuous chart axis. */
  days: string[];
  /** Every local Monday (YYYY-MM-DD) in the range, oldest first. */
  weeks: string[];
  agentsByDay: { day: string; key: AgentSeriesKey; value: number; reviewGates?: number }[];
  tokensByDay: { day: string; key: 'control-plane' | 'agents'; value: number }[];
  messagesByDay: { day: string; key: 'you' | 'control-plane'; value: number }[];
  missionsCompletedByWeek: { week: string; value: number }[];
  /** now − 7 days. A week that ends after this instant is still settling under the idle rule. */
  settlingSince: string;
  byProject: ControlPlaneProjectRow[];
  byType: ControlPlaneTypeRow[];
  missions: ControlPlaneMissionRow[];
}
