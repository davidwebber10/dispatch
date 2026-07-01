// Overseer membrane — escalation Need derivation (the real approve/deny/answer cards).
import { describe, it, expect } from 'vitest';
import { convItemsToStream, groupByMission, mapStatus, needsFromThreads } from './live';
import type { ConvItem, PendingPermission, Terminal } from '../../api/types';

function term(id: string, config: Record<string, unknown>, status = 'needs_input'): Terminal {
  return {
    id,
    sessionId: 's',
    type: 'claude-code',
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

const agent = (id: string, agentType = 'implementer', mission?: string) =>
  term(id, { transport: 'structured', role: 'agent', agentType, ...(mission ? { mission } : {}) });

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

describe('convItemsToStream — message attribution', () => {
  const img = (imageFromUser?: boolean): ConvItem => ({ kind: 'image', imageUrl: 'data:image/png;base64,AAAA', imageFromUser });

  it('attributes a human-attached image to "You" (right-aligned), not Dispatch (BUG 3)', () => {
    const [msg] = convItemsToStream([img(true)]);
    expect(msg.isImage).toBe(true);
    expect(msg.isUser).toBe(true);
    expect(msg.who).toBe('You');
    expect(msg.isOverseer).toBe(false);
  });

  it('keeps an agent/tool/coordinator image unattributed (renders as a Dispatch turn)', () => {
    const [msg] = convItemsToStream([img(false)]);
    expect(msg.isImage).toBe(true);
    expect(msg.isUser).toBe(false);
    expect(msg.who).toBeNull();
  });

  it('maps user text → You and assistant text → Dispatch', () => {
    const stream = convItemsToStream([
      { kind: 'user', text: 'do the thing' },
      { kind: 'assistant', text: 'on it' },
    ]);
    expect(stream.map((m) => [m.isUser, m.isOverseer, m.text])).toEqual([
      [true, false, 'do the thing'],
      [false, true, 'on it'],
    ]);
  });
});
