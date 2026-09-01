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

// Regression coverage for the "answering the coordinator's own AskUserQuestion makes it
// vanish" bug: before this branch existed, an AskUserQuestion tool_use/tool_result pair
// matched none of convItemsToStream's cases and was silently dropped — the live
// coordinatorPending overlay (Stream.tsx) was the ONLY place it ever rendered, and it
// unmounts the instant the question is answered. Now the answered pair becomes a durable
// 'answeredQuestion' StreamMessage that stays in the stream.
describe('convItemsToStream — answered AskUserQuestion', () => {
  it('turns an AskUserQuestion tool_use + its tool_result into an answeredQuestion message', () => {
    const items: ConvItem[] = [
      { kind: 'tool', toolId: 'tu-1', toolName: 'AskUserQuestion', toolInput: JSON.stringify({ questions: [{ question: 'Deploy now?', options: ['Yes', 'No'] }] }) },
      { kind: 'tool-result', toolId: 'tu-1', text: 'Your questions have been answered: "Deploy now?"="Yes". You can now continue with these answers in mind.' },
    ];
    const stream = convItemsToStream(items);
    expect(stream).toHaveLength(1);
    expect(stream[0].isAnsweredQuestion).toBe(true);
    expect(stream[0].kind).toBe('answeredQuestion');
    expect(stream[0].questions?.[0]?.question).toBe('Deploy now?');
    expect(stream[0].resultText).toContain('"Deploy now?"="Yes"');
  });

  it('renders nothing for a still-pending AskUserQuestion (no tool_result yet)', () => {
    const items: ConvItem[] = [
      { kind: 'tool', toolId: 'tu-2', toolName: 'AskUserQuestion', toolInput: JSON.stringify({ questions: [{ question: 'Which env?', options: ['staging', 'prod'] }] }) },
    ];
    expect(convItemsToStream(items)).toHaveLength(0);
  });

  it('does not confuse an AskUserQuestion tool_result with an agent-management tool_result sharing the pairing pass', () => {
    const items: ConvItem[] = [
      { kind: 'tool', toolId: 'tu-3', toolName: 'AskUserQuestion', toolInput: JSON.stringify({ questions: [{ question: 'Proceed?', options: ['Yes'] }] }) },
      { kind: 'tool', toolId: 'tu-4', toolName: 'spawn_agent', toolInput: JSON.stringify({ agentType: 'implementer' }) },
      { kind: 'tool-result', toolId: 'tu-3', text: 'Your questions have been answered: "Proceed?"="Yes". You can now continue with these answers in mind.' },
      { kind: 'tool-result', toolId: 'tu-4', text: JSON.stringify({ agentId: 'a1', label: 'Implementer' }) },
    ];
    const stream = convItemsToStream(items);
    expect(stream).toHaveLength(2);
    expect(stream.find((m) => m.isAnsweredQuestion)?.questions?.[0]?.question).toBe('Proceed?');
    expect(stream.find((m) => m.isAgentCard)?.agentId).toBe('a1');
  });
});

// ---- Stream render parity: generic tools / thinking / report_status / footers / notices ----
// Before this, convItemsToStream rendered FOUR kinds and silently dropped the rest — the
// coordinator looked idle while it ran tools, and its report_status findings never showed.
describe('convItemsToStream — render parity (machinery, thinking, status, footer, notice)', () => {
  const bash = (id: string, cmd: string): ConvItem => ({ kind: 'tool', toolId: id, toolName: 'Bash', toolInput: JSON.stringify({ command: cmd }) });
  const res = (id: string, text = 'ok'): ConvItem => ({ kind: 'tool-result', toolId: id, text });

  it('a generic tool call + its result become ONE machinery message carrying both items', () => {
    const stream = convItemsToStream([bash('b1', 'ls'), res('b1')]);
    expect(stream).toHaveLength(1);
    expect(stream[0].isMachinery).toBe(true);
    expect(stream[0].machineryItems?.map((i) => [i.kind, i.toolId])).toEqual([['tool', 'b1'], ['tool-result', 'b1']]);
  });

  it('consecutive tools coalesce into one machinery message; prose splits the run', () => {
    const stream = convItemsToStream([
      bash('b1', 'ls'), res('b1'),
      bash('b2', 'pwd'), res('b2'),
      { kind: 'assistant', text: 'both ran fine' },
      bash('b3', 'whoami'), res('b3'),
    ]);
    expect(stream.map((s) => s.isMachinery ? `mach:${s.machineryItems?.length}` : s.text)).toEqual([
      'mach:4', 'both ran fine', 'mach:2',
    ]);
  });

  it('report_status becomes a status message and its {ok} result is swallowed', () => {
    const input = JSON.stringify({ state: 'blocked', summary: 'waiting on CI', blocker: 'run 42 pending' });
    const stream = convItemsToStream([
      { kind: 'tool', toolId: 'rs1', toolName: 'mcp__dispatch__report_status', toolInput: input },
      { kind: 'tool-result', toolId: 'rs1', text: '{"ok":true}' },
    ]);
    expect(stream).toHaveLength(1);
    expect(stream[0].isStatus).toBe(true);
    expect(stream[0].statusInput).toBe(input);
  });

  it('a still-streaming report_status (unparsable input) stays generic machinery', () => {
    const stream = convItemsToStream([
      { kind: 'tool', toolId: 'rs1', toolName: 'mcp__dispatch__report_status', toolInput: '{"state":"do' },
    ]);
    expect(stream).toHaveLength(1);
    expect(stream[0].isMachinery).toBe(true);
  });

  it('thinking becomes a thinking message; result becomes a footer; notice becomes a notice', () => {
    const stream = convItemsToStream([
      { kind: 'thinking', text: 'weighing options' },
      { kind: 'result', costUsd: 0.12, tokensIn: 100, tokensOut: 50, durationMs: 4200 },
      { kind: 'notice', text: 'Background task finished' },
    ]);
    expect(stream.map((s) => [!!s.isThinking, !!s.isFooter, !!s.isNotice])).toEqual([
      [true, false, false], [false, true, false], [false, false, true],
    ]);
    expect(stream[0].text).toBe('weighing options');
    expect(stream[1].footerItem?.costUsd).toBe(0.12);
    expect(stream[2].text).toBe('Background task finished');
  });

  it('REGRESSION: agency tools still become agent cards, never machinery', () => {
    const stream = convItemsToStream([
      { kind: 'tool', toolId: 's1', toolName: 'spawn_agent', toolInput: JSON.stringify({ agentType: 'implementer' }) },
      { kind: 'tool-result', toolId: 's1', text: JSON.stringify({ agentId: 'a9', label: 'Fixer' }) },
    ]);
    expect(stream).toHaveLength(1);
    expect(stream[0].isAgentCard).toBe(true);
    expect(stream[0].isMachinery).toBeFalsy();
  });
});
