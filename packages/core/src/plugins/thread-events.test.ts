import { describe, it, expect, beforeEach } from 'vitest';
import { ThreadEvents, redactThreadEvent, type ThreadEvent } from './thread-events.js';
import type { HarnessEvent } from '../runtime/events.js';

/** Thread events for plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, section 3.3). */
describe('ThreadEvents (2026-11-07)', () => {
  let out: Record<string, unknown>[];
  let seen: ThreadEvent[];
  let now: number;
  let te: ThreadEvents;
  const identity = (type: string, over: Record<string, unknown> = {}) => ({
    terminalId: 't1', provider: 'claude-code', generation: 'g', sequence: 1, eventId: 'g:1', observedAt: new Date(now).toISOString(), transport: 'structured', type, ...over,
  }) as HarnessEvent;

  beforeEach(() => {
    out = []; seen = []; now = 1_700_000_000_000;
    te = new ThreadEvents({ broadcast: (e) => { out.push(e); } }, (id) => (id === 't1' ? { sessionId: 's1', harness: 'claude-code' } : null), () => now);
    te.subscribe((e) => seen.push(e));
  });

  it('a UserPromptSubmit hook becomes thread:prompt with the text and its length', () => {
    te.onHookPayload('claude', 't1', { hook_event_name: 'UserPromptSubmit', prompt: 'Fix the login bug' });
    expect(out).toEqual([{ type: 'thread:prompt', terminalId: 't1', sessionId: 's1', harness: 'claude-code', at: new Date(now).toISOString(), source: 'user', text: 'Fix the login bug', textLength: 17 }]);
    expect(seen).toHaveLength(1);
  });

  it('a Pretty prompt reported by the session service becomes thread:prompt once (the hook path does not double it)', () => {
    te.onPrompt('t1', 'Hello there', 'user');
    expect(out.map((e) => e.type)).toEqual(['thread:prompt']);
    expect(out[0]).toMatchObject({ text: 'Hello there', textLength: 11, source: 'user' });
  });

  it('the service path and the hook path report one prompt once, even when whitespace differs (a PTY paste)', () => {
    te.onPrompt('t1', 'Fix the\r\nlogin bug ', 'user');
    te.onHookPayload('claude', 't1', { hook_event_name: 'UserPromptSubmit', prompt: 'Fix the\nlogin bug' });
    expect(out.filter((e) => e.type === 'thread:prompt')).toHaveLength(1);
    // The same words sent again later are a new prompt.
    te.onHookPayload('claude', 't1', { hook_event_name: 'UserPromptSubmit', prompt: 'Fix the\nlogin bug' });
    expect(out.filter((e) => e.type === 'thread:prompt')).toHaveLength(2);
  });

  it('a coordinator or peer send keeps its source when the hook reports it afterwards', () => {
    te.onPrompt('t1', 'Please run the tests', 'coordinator');
    te.onHookPayload('claude', 't1', { hook_event_name: 'UserPromptSubmit', prompt: 'Please run the tests' });
    te.onPrompt('t1', 'From a peer', 'thread');
    te.onHookPayload('claude', 't1', { hook_event_name: 'UserPromptSubmit', prompt: 'From a peer' });
    const prompts = out.filter((e) => e.type === 'thread:prompt');
    expect(prompts.map((e) => (e as { source: string }).source)).toEqual(['coordinator', 'thread']);
  });

  it('a prompt in a thread a schedule or a role started is tagged source "schedule", never "user" (coach review finding 4)', () => {
    const auto = new ThreadEvents({ broadcast: (e) => { out.push(e); } }, (id) => (id === 'r1' ? { sessionId: 's1', harness: 'claude-code', automated: true } : null), () => now);
    // The runner's launch prompt reaches the hook: nobody reported it first.
    auto.onHookPayload('claude', 'r1', { hook_event_name: 'UserPromptSubmit', prompt: 'Run the weekly report' });
    auto.onPrompt('r1', 'and the follow-up', 'user');
    expect(out.filter((e) => e.type === 'thread:prompt').map((e) => e.source)).toEqual(['schedule', 'schedule']);
    // A coordinator's send keeps its own source.
    auto.onPrompt('r1', 'from the Control Plane', 'coordinator');
    expect(out.at(-1)).toMatchObject({ source: 'coordinator' });
  });

  it('a PreToolUse hook becomes thread:tool with the name, the input and its size', () => {
    te.onHookPayload('claude', 't1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
    expect(out[0]).toMatchObject({ type: 'thread:tool', terminalId: 't1', tool: 'Bash', input: { command: 'rm -rf build' }, inputLength: JSON.stringify({ command: 'rm -rf build' }).length });
  });

  it('a native assistant frame with tool_use blocks becomes one thread:tool per block', () => {
    te.onNativeFrame('t1', { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'x', name: 'Read', input: { path: 'a.ts' } }, { type: 'tool_use', id: 'y', name: 'mcp__dispatch__preview', input: {} }] } });
    expect(out.map((e) => [e.type, (e as { tool?: string }).tool])).toEqual([['thread:tool', 'Read'], ['thread:tool', 'mcp__dispatch__preview']]);
  });

  it('turn.started, usage.observed and turn.completed become thread:turn with tokens, cost, duration and outcome', () => {
    te.onHarnessEvent(identity('turn.started'));
    now += 4200;
    te.onHarnessEvent(identity('usage.observed', { measurements: [{ model: 'm', source: 'structured', input: 900, output: 50, cacheRead: 100, cacheCreate: 0, reportedCostUsd: 0.01 }, { model: 'm', source: 'structured', input: 200, output: 10, cacheRead: 0, cacheCreate: 0 }] }));
    now += 800;
    te.onHarnessEvent(identity('turn.completed', { outcome: 'idle', detail: { declared: true, state: 'done', summary: 'did it' } }));
    expect(out).toEqual([{ type: 'thread:turn', terminalId: 't1', sessionId: 's1', harness: 'claude-code', at: new Date(now).toISOString(), ms: 5000, inputTokens: 1200, outputTokens: 60, costUsd: 0.01, outcome: 'idle', declared: true, summary: 'did it' }]);
  });

  it('a Stop hook ends a CLI turn started by UserPromptSubmit with partial token data', () => {
    te.onHookPayload('claude', 't1', { hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    now += 3000;
    te.onHookPayload('claude', 't1', { hook_event_name: 'Stop' });
    const turn = out.find((e) => e.type === 'thread:turn')!;
    expect(turn).toMatchObject({ ms: 3000, inputTokens: null, outputTokens: null, costUsd: null, outcome: 'idle', partial: true });
  });

  it('a turn that failed reports the outcome failed', () => {
    te.onHarnessEvent(identity('turn.started'));
    te.onHarnessEvent(identity('turn.failed'));
    expect(out[0]).toMatchObject({ type: 'thread:turn', outcome: 'failed' });
  });

  it('report_status becomes thread:status', () => {
    te.onStatus('t1', { state: 'needs_you', summary: 'Which db?', ask: 'Pick one' });
    expect(out[0]).toEqual({ type: 'thread:status', terminalId: 't1', sessionId: 's1', harness: 'claude-code', at: new Date(now).toISOString(), state: 'needs_you', summary: 'Which db?', ask: 'Pick one' });
  });

  it('a spawn becomes thread:spawned with the tools the thread was launched with', () => {
    te.onSpawned('t1', ['dispatch', 'plugin-coach']);
    expect(out[0]).toEqual({ type: 'thread:spawned', terminalId: 't1', sessionId: 's1', harness: 'claude-code', at: new Date(now).toISOString(), toolsAvailable: ['dispatch', 'plugin-coach'] });
  });

  it('an unknown terminal produces nothing; a subscriber that throws does not stop the others', () => {
    te.onPrompt('nope', 'x', 'user');
    expect(out).toEqual([]);
    te.subscribe(() => { throw new Error('boom'); });
    const after: ThreadEvent[] = [];
    te.subscribe((e) => after.push(e));
    te.onPrompt('t1', 'x', 'user');
    expect(after).toHaveLength(1);
  });

  it('redactThreadEvent strips the prompt text and the tool input but keeps the sizes', () => {
    const prompt = { type: 'thread:prompt', terminalId: 't1', sessionId: 's1', harness: 'claude-code', at: 'now', source: 'user', text: 'secret', textLength: 6 } as ThreadEvent;
    expect(redactThreadEvent(prompt)).toEqual({ type: 'thread:prompt', terminalId: 't1', sessionId: 's1', harness: 'claude-code', at: 'now', source: 'user', textLength: 6 });
    const tool = { type: 'thread:tool', terminalId: 't1', sessionId: 's1', harness: 'claude-code', at: 'now', tool: 'Bash', input: { command: 'x' }, inputLength: 15 } as ThreadEvent;
    expect(redactThreadEvent(tool)).toEqual({ type: 'thread:tool', terminalId: 't1', sessionId: 's1', harness: 'claude-code', at: 'now', tool: 'Bash', inputLength: 15 });
    const turn = { type: 'thread:turn', terminalId: 't1', sessionId: 's1', harness: 'claude-code', at: 'now', ms: 1, inputTokens: 1, outputTokens: 1, costUsd: null, outcome: 'idle', summary: 'did it' } as ThreadEvent;
    expect(redactThreadEvent(turn)).toEqual(turn);
  });
});
