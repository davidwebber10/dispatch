// Overseer membrane — escalation Need derivation (the real approve/deny/answer cards).
import { describe, it, expect } from 'vitest';
import { agencyCards, groupByMission, isOrphanAgencyResult, isStructuredWorker, mapStatus, needsFromThreads, terminalToAgentThread } from './live';
import type { ConvItem, PendingPermission, Terminal } from '../../api/types';
import { AGENT_TYPE } from './types';

function term(id: string, config: Record<string, unknown>, status = 'needs_input', type: Terminal['type'] = 'claude-code'): Terminal {
  return {
    id,
    sessionId: 's',
    type,
    label: id,
    pid: null,
    externalId: null,
    workingDir: null,
    status: status as Terminal['status'],
    createdAt: new Date().toISOString(),
    config,
    archivedAt: null,
    sortOrder: 0,
  };
}

const agent = (id: string, agentType = 'implementer', mission?: string, type: Terminal['type'] = 'claude-code') =>
  term(id, { transport: 'structured', role: 'agent', agentType, ...(mission ? { mission } : {}) }, 'needs_input', type);

const waiting = { threadStatus: 'needs_input' };

describe('needsFromThreads — the membrane', () => {
  it('builds an approval Need from a gated-tool pending (tool + command, Approve/Deny)', () => {
    const pending: PendingPermission = { requestId: 'r1', toolName: 'Bash', input: { command: 'pnpm add jose' } };
    const needs = needsFromThreads([agent('a1', 'implementer', 'Auth')], { a1: waiting }, { a1: pending });
    expect(needs).toHaveLength(1);
    expect(needs[0].id).toBe('a1'); // resolve key = terminal id
    expect(needs[0].isApproval).toBe(true);
    expect(needs[0].cmds).toEqual(['pnpm add jose']);
    expect(needs[0].actions.map((a) => a.label)).toEqual(['Approve', 'Deny']);
  });

  it('builds a question Need from an AskUserQuestion pending (each option → an action button)', () => {
    const pending: PendingPermission = {
      requestId: 'r2',
      toolName: 'AskUserQuestion',
      questions: [{ question: 'iOS 16 too?', header: 'Scope', options: ['17+ only', 'Include 16'], multiSelect: false }],
    };
    const needs = needsFromThreads([agent('a2', 'researcher')], { a2: waiting }, { a2: pending });
    expect(needs[0].isQuestion).toBe(true);
    expect(needs[0].framing).toBe('iOS 16 too?');
    expect(needs[0].title).toContain('Scope');
    expect(needs[0].actions.map((a) => a.label)).toEqual(['17+ only', 'Include 16']);
  });

  it('handles object-shaped question options ({ label })', () => {
    const pending: PendingPermission = {
      requestId: 'r4',
      toolName: 'AskUserQuestion',
      questions: [{ question: 'pick', options: [{ label: 'Yes' }, { label: 'No' }] }],
    };
    const needs = needsFromThreads([agent('a4', 'reviewer')], { a4: waiting }, { a4: pending });
    expect(needs[0].actions.map((a) => a.label)).toEqual(['Yes', 'No']);
  });

  it('falls back to a coarse Open card when no pending has been fetched yet', () => {
    const needs = needsFromThreads([agent('a3', 'planner')], { a3: waiting }, {});
    expect(needs[0].actions.map((a) => a.label)).toEqual(['Open']);
  });

  it('ignores coordinator threads and threads not in needs_input', () => {
    const coord = term('c', { transport: 'structured', role: 'coordinator' });
    const working = agent('w');
    const needs = needsFromThreads([coord, working], { c: waiting, w: { threadStatus: 'working' } }, {});
    expect(needs).toHaveLength(0);
  });
});

// A dormant thread that ended its turn on a wake-scheduler tool (ScheduleWakeup/CronCreate,
// see structured/manager.ts) — StatusService.markScheduled persists this on BOTH the coarse
// `status` and the rich `threadStatus` fields (mirrors how every other status round-trips).
const scheduled = { status: 'scheduled', threadStatus: 'scheduled', activity: 'Scheduled — watching CI run' };

describe('scheduled status — dormant wake-scheduler threads (not done, not waiting-on-you)', () => {
  it('mapStatus routes a persisted "scheduled" terminal to ThreadStatus "scheduled"', () => {
    expect(mapStatus(agent('s1'), scheduled)).toBe('scheduled');
  });

  it('a scheduled thread never appears in needsFromThreads — nothing for the human to do', () => {
    const needs = needsFromThreads([agent('s2')], { s2: scheduled }, {});
    expect(needs).toHaveLength(0);
  });

  it('groupByMission places a scheduled thread in the LIVE bucket, not queued/outcomes', () => {
    const missions = groupByMission([agent('s3', 'implementer', 'Auth')], { s3: scheduled });
    expect(missions).toHaveLength(1);
    expect(missions[0].threads.map((t) => t.key)).toEqual(['s3']);
    expect(missions[0].threads[0].isScheduled).toBe(true);
    expect(missions[0].queued).toHaveLength(0);
    expect(missions[0].outcomes).toHaveLength(0);
  });
});

// Phase 2 straggler: isStructuredWorker rejected every worker whose terminal `type` wasn't
// 'claude-code', so a Codex/Grok/OpenCode worker (now spawnable via the Control Plane
// selector — see packages/core/src/overseer/worker-payload.ts, `type: input.resolved.harness`)
// silently vanished from the Overseer rail and archived outcomes.
describe('non-Claude structured workers (Control Plane Phase 2 selector)', () => {
  it('isStructuredWorker recognizes a codex-type worker, not just claude-code', () => {
    const codexWorker = agent('cx1', 'implementer', undefined, 'codex');
    expect(isStructuredWorker(codexWorker)).toBe(true);
  });

  it('groupByMission surfaces a codex worker in the rail alongside claude workers', () => {
    const missions = groupByMission([agent('cx2', 'implementer', 'Payments', 'codex')], { cx2: { threadStatus: 'working' } });
    expect(missions).toHaveLength(1);
    expect(missions[0].threads.map((t) => t.key)).toEqual(['cx2']);
  });

  it('still excludes an unstructured type entirely (e.g. a plain shell) even with agent-shaped config', () => {
    const shellLike = agent('sh1', 'implementer', undefined, 'shell');
    expect(isStructuredWorker(shellLike)).toBe(false);
  });
});

// ---- Agent cards: the pure pre-pass behind the Control Plane's toolCard hook ----
// (Ported from the old convItemsToStream agent-card cases. The rest of those cases —
// attribution, answered questions, machinery, thinking/status/footer/notice — are now
// renderTimeline's own behaviour and are covered by rendering, in timeline.test.tsx.)
describe('agencyCards — agency calls paired into agent cards', () => {
  const call = (toolId: string, toolName: string, args: Record<string, unknown> = {}): ConvItem => ({ kind: 'tool', toolId, toolName, toolInput: JSON.stringify(args) });
  const res = (toolId: string, body: unknown, isError = false): ConvItem => ({ kind: 'tool-result', toolId, text: typeof body === 'string' ? body : JSON.stringify(body), ...(isError ? { isError } : {}) });

  it('REGRESSION: a bare spawn_agent + result becomes a card', () => {
    const cards = agencyCards([call('s1', 'spawn_agent', { agentType: 'implementer' }), res('s1', { agentId: 'a9', label: 'Fixer' })]);
    expect(cards.get('s1')).toEqual({ agentId: 'a9', name: 'Fixer', agentType: 'implementer', mission: undefined, action: 'spawned' });
  });

  it('mcp__dispatch__spawn_agent + result become a card with name, type and mission', () => {
    const cards = agencyCards([
      call('s1', 'mcp__dispatch__spawn_agent', { agentType: 'researcher' }),
      res('s1', { agentId: 'a1', label: 'Digger', mission: 'Delta' }),
    ]);
    expect(cards.get('s1')).toEqual({ agentId: 'a1', name: 'Digger', agentType: 'researcher', mission: 'Delta', action: 'spawned' });
  });

  it('queue_agent → "queued"; a spawn with no label reads "Agent"', () => {
    const cards = agencyCards([call('q1', 'queue_agent', { agentType: 'planner' }), res('q1', { agentId: 'a3' })]);
    expect(cards.get('q1')).toMatchObject({ agentId: 'a3', name: 'Agent', agentType: 'planner', action: 'queued' });
  });

  it('a later mcp__dispatch__message_agent card backfills name/type/mission from the namespaced spawn', () => {
    const cards = agencyCards([
      call('s1', 'mcp__dispatch__spawn_agent', { agentType: 'reviewer' }),
      res('s1', { agentId: 'a2', label: 'Checker', mission: 'Audit' }),
      call('m1', 'mcp__dispatch__message_agent', { agentId: 'a2', text: 'go' }),
      res('m1', { ok: true, agentId: 'a2' }),
    ]);
    expect(cards.get('m1')).toEqual({ agentId: 'a2', name: 'Checker', agentType: 'reviewer', mission: 'Audit', action: 'messaged' });
  });

  it('a start_agent whose spawn is outside the window shows the bare id with no type', () => {
    const cards = agencyCards([call('st1', 'start_agent', { agentId: 'zz' }), res('st1', { ok: true, agentId: 'zz' })]);
    expect(cards.get('st1')).toEqual({ agentId: 'zz', name: 'zz', agentType: undefined, mission: undefined, action: 'started' });
  });

  it('draws nothing (null) for a call still waiting on its result, or one whose result is not JSON / has no agentId', () => {
    const cards = agencyCards([
      call('p1', 'spawn_agent'),
      call('p2', 'spawn_agent'), res('p2', 'not json'),
      call('p3', 'spawn_agent'), res('p3', { ok: true }),
    ]);
    expect(cards.get('p1')).toBeNull();
    expect(cards.get('p2')).toBeNull();
    expect(cards.get('p3')).toBeNull();
  });

  it('an errored agency call has no card — it draws as an ordinary tool row with its error', () => {
    const cards = agencyCards([call('e1', 'spawn_agent'), res('e1', 'spawn failed: no such type', true)]);
    expect(cards.has('e1')).toBe(false);
  });

  it('complete_agent and every non-agency tool are left to the default rendering', () => {
    const cards = agencyCards([
      call('c1', 'mcp__dispatch__complete_agent', { agentId: 'a1' }), res('c1', { ok: true, agentId: 'a1' }),
      call('b1', 'Bash', { command: 'ls' }), res('b1', 'ok'),
      call('tu-3', 'AskUserQuestion', { questions: [{ question: 'Proceed?', options: ['Yes'] }] }),
    ]);
    expect(cards.size).toBe(0);
  });

  it('does not confuse an AskUserQuestion result with an agency result in the same window', () => {
    const cards = agencyCards([
      call('tu-3', 'AskUserQuestion', { questions: [{ question: 'Proceed?', options: ['Yes'] }] }),
      call('tu-4', 'spawn_agent', { agentType: 'implementer' }),
      res('tu-3', 'Your questions have been answered: "Proceed?"="Yes". You can now continue with these answers in mind.'),
      res('tu-4', { agentId: 'a1', label: 'Implementer' }),
    ]);
    expect([...cards.keys()]).toEqual(['tu-4']);
    expect(cards.get('tu-4')?.agentId).toBe('a1');
  });
});

describe('isOrphanAgencyResult — what the Control Plane drops when renderTimeline cannot pair a result', () => {
  it('a TRUE orphan agency result (its call outside the window) is dropped', () => {
    expect(isOrphanAgencyResult({ kind: 'tool-result', toolId: 'gone', text: JSON.stringify({ ok: true, agentId: 'a1' }) })).toBe(true);
  });

  it('a real tool\'s output, a JSON result without an agentId, and an id-less result are kept', () => {
    expect(isOrphanAgencyResult({ kind: 'tool-result', toolId: 'gone', text: 'line1\nline2' })).toBe(false);
    expect(isOrphanAgencyResult({ kind: 'tool-result', toolId: 'gone', text: JSON.stringify({ ok: true }) })).toBe(false);
    expect(isOrphanAgencyResult({ kind: 'tool-result', text: JSON.stringify({ agentId: 'a1' }) })).toBe(false);
  });
});

describe('fable review-gate agent types (web)', () => {
  it('terminalToAgentThread keeps design-reviewer / code-reviewer instead of falling back to implementer', () => {
    expect(terminalToAgentThread(agent('t-design-reviewer', 'design-reviewer')).type).toBe('design-reviewer');
    expect(terminalToAgentThread(agent('t-code-reviewer', 'code-reviewer')).type).toBe('code-reviewer');
  });

  it('AGENT_TYPE has icon+label entries for both', () => {
    expect(AGENT_TYPE['design-reviewer']).toEqual({ icon: 'ph-ruler', label: 'design review' });
    expect(AGENT_TYPE['code-reviewer']).toEqual({ icon: 'ph-git-pull-request', label: 'code review' });
  });
});
