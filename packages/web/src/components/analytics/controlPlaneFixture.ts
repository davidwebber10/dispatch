import type { ControlPlaneAnalytics } from '../../api/types';

/** A small payload in the real shape, shared by the Control Plane view tests. */
export const CP_FIXTURE: ControlPlaneAnalytics = {
  summary: {
    sessions: 15, sessionsActive: 5, sessionsNew: 1, activeDays: 20, missionsStarted: 15,
    missionsCompleted: 11, agentsStarted: 437, controlPlaneTokens: 1_649_010_423, agentTokens: 4_422_830_988,
  },
  days: ['2026-09-27', '2026-09-28', '2026-09-29'],
  weeks: ['2026-09-21', '2026-09-28'],
  agentsByDay: [
    { day: '2026-09-27', key: 'implementer', value: 12 },
    { day: '2026-09-28', key: 'review', value: 3, reviewGates: 2 },
  ],
  tokensByDay: [
    { day: '2026-09-27', key: 'agents', value: 400_000_000 },
    { day: '2026-09-27', key: 'control-plane', value: 150_000_000 },
  ],
  messagesByDay: [
    { day: '2026-09-27', key: 'control-plane', value: 25 },
    { day: '2026-09-27', key: 'you', value: 30 },
  ],
  missionsCompletedByWeek: [{ week: '2026-09-21', value: 3 }],
  settlingSince: '2026-09-22T12:00:00.000Z',
  byProject: [
    { projectId: 'p1', name: 'PW Legacy', sessions: 1, activeDays: 14, missionsStarted: 3, missionsCompleted: 3, agents: 146, controlPlaneTokens: 190, agentTokens: 810 },
    { projectId: 'p2', name: 'Sandbox', sessions: 1, activeDays: 0, missionsStarted: 0, missionsCompleted: 0, agents: 0, controlPlaneTokens: 0, agentTokens: 0 },
    { projectId: 'p3', name: 'Dispatch', sessions: 2, activeDays: 0, missionsStarted: 0, missionsCompleted: 0, agents: 0, controlPlaneTokens: 0, agentTokens: 0 },
  ],
  byType: [
    { agentType: 'code-reviewer', agents: 30, avgTurnSeconds: 255, tokens: 81_000_000, cli: { codex: 19, 'claude-code': 11 } },
  ],
  missions: [
    { projectId: 'p1', projectName: 'PW Legacy', mission: 'Sage consumers', agents: 46, reviewGates: 13, firstAt: '2026-09-16T10:00:00.000Z', lastAt: '2026-09-29T10:00:00.000Z', lengthDays: 14, status: 'active' },
    { projectId: 'p1', projectName: 'PW Legacy', mission: 'PLM UAT Round 1', agents: 49, reviewGates: 2, firstAt: '2026-09-01T10:00:00.000Z', lastAt: '2026-09-09T10:00:00.000Z', lengthDays: 9, status: 'completed' },
  ],
};
