import { describe, it, expect } from 'vitest';
import { CodexTranslator, buildApprovalResponse, type TranslatedAction } from './codex-translate.js';
import * as fx from './codex-frames.fixture.js';

/** Only the `event` payloads (drops session/busy/idle/approval control actions). */
function events(actions: TranslatedAction[]): any[] {
  return actions.filter((a) => a.kind === 'event').map((a) => (a as any).event);
}
const kinds = (actions: TranslatedAction[]) => actions.map((a) => a.kind);

describe('CodexTranslator — server → Claude-shaped stream', () => {
  it('thread/started → a session action carrying the ThreadId (the external_id)', () => {
    const t = new CodexTranslator();
    const out = t.translate(fx.threadStarted as any);
    expect(out).toEqual([{ kind: 'session', sessionId: (fx.threadStarted as any).params.thread.id }]);
  });

  it('turn/started → busy; turn/completed → a result footer + idle', () => {
    const t = new CodexTranslator();
    expect(kinds(t.translate(fx.turnStarted as any))).toEqual(['busy']);
    const done = t.translate(fx.turnCompleted as any);
    expect(kinds(done)).toEqual(['event', 'idle']);
    expect(events(done)[0]).toMatchObject({ type: 'result', subtype: 'codex_turn', is_error: false });
  });

  // --- Task 7: turn-end status truth for Codex (parity with the Claude manager's `result`
  // handler — see manager.ts). The translator has no report_status/declared awareness at
  // all (that lives on CodexSession in codex-manager.ts); it ONLY runs the text heuristic
  // against the last completed agentMessage's own prose, stashed at item/completed time.

  it('a turn whose last agent message asks a question ends in needs-help, not idle', () => {
    const t = new CodexTranslator();
    const actions = [
      ...t.translate({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Rewired the rail. Does that look right to you?' } } }),
      ...t.translate({ method: 'turn/completed', params: {} }),
    ];
    expect(kinds(actions)).toContain('needs-help');
    expect(kinds(actions)).not.toContain('idle');
  });

  it('a turn whose last agent message reports completion ends idle', () => {
    const t = new CodexTranslator();
    const actions = [
      ...t.translate({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Merged to main. 6 commits, all green.' } } }),
      ...t.translate({ method: 'turn/completed', params: {} }),
    ];
    expect(kinds(actions)).toContain('idle');
    expect(kinds(actions)).not.toContain('needs-help');
  });

  it('the stashed agent text does not leak into the NEXT turn once consumed', () => {
    const t = new CodexTranslator();
    // First turn ends on a question.
    t.translate({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Does that look right to you?' } } });
    t.translate({ method: 'turn/completed', params: {} });
    // Second turn produces no agentMessage completion at all before its own boundary —
    // if the stash weren't cleared, the first turn's question would wrongly fire again.
    const actions = t.translate({ method: 'turn/completed', params: {} });
    expect(kinds(actions)).toContain('idle');
    expect(kinds(actions)).not.toContain('needs-help');
  });

  it('agentMessage deltas → message_start then a text content block streamed by deltas', () => {
    const t = new CodexTranslator();
    t.translate(fx.turnStarted as any); // establishes the turn
    const first = events(t.translate(fx.agentMsgDelta1 as any));
    // First delta lazily opens the stream: message_start, content_block_start(text), delta.
    expect(first[0]).toEqual({ type: 'stream_event', event: { type: 'message_start' } });
    expect(first[1]).toMatchObject({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
    expect(first[2]).toMatchObject({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: (fx.agentMsgDelta1 as any).params.delta } } });
    // A second delta for the SAME item reuses the block — just another delta, no new start.
    const second = events(t.translate(fx.agentMsgDelta2 as any));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: (fx.agentMsgDelta2 as any).params.delta } } });
  });

  it('reasoning textDelta → a streamed thinking block', () => {
    const t = new CodexTranslator();
    t.translate(fx.turnStarted as any);
    const frame = { method: 'item/reasoning/textDelta', params: { threadId: 'x', turnId: 'y', itemId: 'rs_1', delta: 'weighing options', contentIndex: 0 } };
    const out = events(t.translate(frame as any));
    expect(out[0]).toEqual({ type: 'stream_event', event: { type: 'message_start' } });
    expect(out[1]).toMatchObject({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });
    expect(out[2]).toMatchObject({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing options' } } });
  });

  it('assistant text and reasoning in one turn get DISTINCT block indexes', () => {
    const t = new CodexTranslator();
    t.translate(fx.turnStarted as any);
    t.translate(fx.agentMsgDelta1 as any); // opens text at index 0
    const r = events(t.translate({ method: 'item/reasoning/textDelta', params: { itemId: 'rs_1', delta: 'x', contentIndex: 0 } } as any));
    // message_start already emitted, so reasoning just opens a new block at index 1.
    expect(r[0]).toMatchObject({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'thinking' } } });
  });

  it('a commandExecution item → assistant tool_use (start) then user tool_result (complete)', () => {
    const t = new CodexTranslator();
    const started = events(t.translate(fx.cmdStarted as any));
    expect(started[0]).toMatchObject({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', id: (fx.cmdStarted as any).params.item.id }] } });
    expect(started[0].message.content[0].input).toMatchObject({ command: (fx.cmdStarted as any).params.item.command });
    const done = events(t.translate(fx.cmdCompleted as any));
    expect(done[0]).toMatchObject({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: (fx.cmdCompleted as any).params.item.id, is_error: false }] } });
    expect(done[0].message.content[0].content).toContain('RTK'); // the real captured stdout
  });

  it('a userMessage item is ignored (the manager synthesizes the echo instead)', () => {
    const t = new CodexTranslator();
    expect(t.translate(fx.userMessageStarted as any)).toEqual([]);
  });

  it('thread/tokenUsage/updated → a zero-content assistant usage event for the context bar', () => {
    const t = new CodexTranslator();
    const out = events(t.translate(fx.tokenUsage as any));
    const usage = (fx.tokenUsage as any).params.tokenUsage.last;
    expect(out[0]).toMatchObject({ type: 'assistant', message: { content: [], usage: { cache_read_input_tokens: usage.cachedInputTokens, output_tokens: usage.outputTokens } } });
    expect(out[0].message.usage.input_tokens).toBe(usage.inputTokens - usage.cachedInputTokens);
  });
});

describe('CodexTranslator — approvals (the escalate/auto-allow membrane input)', () => {
  it('fileChange approval → a pending built from the cached item diff, with auto-approve accept', () => {
    const t = new CodexTranslator();
    t.translate(fx.fileChangeStarted as any); // caches the changes (approval params omit them)
    const out = t.translate(fx.fileChangeApproval as any);
    expect(out).toHaveLength(1);
    const a = out[0] as any;
    expect(a.kind).toBe('approval');
    expect(a.method).toBe('item/fileChange/requestApproval');
    expect(a.requestId).toBe((fx.fileChangeApproval as any).id);
    expect(a.alwaysSurface).toBe(false);
    expect(a.autoApprove).toEqual({ decision: 'accept' });
    expect(a.pending.toolName).toBe('ApplyPatch');
    expect(a.pending.input.file_path).toContain('hello.txt'); // recovered from the cached item
    expect(a.pending.input.changes[0].diff).toBe('hi\n');
  });

  it('commandExecution approval → Shell pending + accept', () => {
    const t = new CodexTranslator();
    const frame = { method: 'item/commandExecution/requestApproval', id: 7, params: { itemId: 'exec-1', command: 'rm -rf /tmp/x', cwd: '/tmp' } };
    const a = t.translate(frame as any)[0] as any;
    expect(a.pending.toolName).toBe('Shell');
    expect(a.pending.input.command).toBe('rm -rf /tmp/x');
    expect(a.alwaysSurface).toBe(false);
    expect(a.autoApprove).toEqual({ decision: 'accept' });
  });

  it('requestUserInput → AskUserQuestion pending that ALWAYS surfaces', () => {
    const t = new CodexTranslator();
    const frame = {
      method: 'item/tool/requestUserInput', id: 3,
      params: { itemId: 'q-1', questions: [{ id: 'qid', header: 'Deploy?', question: 'Ship it?', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    };
    const a = t.translate(frame as any)[0] as any;
    expect(a.alwaysSurface).toBe(true);
    expect(a.pending.toolName).toBe('AskUserQuestion');
    expect(a.pending.questions[0]).toMatchObject({ id: 'qid', header: 'Deploy?', question: 'Ship it?', options: ['Yes', 'No'] });
  });

  it('permissions approval → Permissions pending + a grant envelope', () => {
    const t = new CodexTranslator();
    const frame = { method: 'item/permissions/requestApproval', id: 9, params: { itemId: 'p-1', reason: 'net', permissions: { network: { allowed: true } }, cwd: '/w' } };
    const a = t.translate(frame as any)[0] as any;
    expect(a.pending.toolName).toBe('Permissions');
    expect(a.autoApprove).toEqual({ permissions: { network: { allowed: true } }, scope: 'turn' });
  });
});

describe('buildApprovalResponse — Claude decision → Codex response envelope', () => {
  it('command/file allow → accept, deny → decline', () => {
    expect(buildApprovalResponse('item/commandExecution/requestApproval', { behavior: 'allow' }, null)).toEqual({ decision: 'accept' });
    expect(buildApprovalResponse('item/fileChange/requestApproval', { behavior: 'deny', message: 'no' }, null)).toEqual({ decision: 'decline' });
  });

  it('requestUserInput allow → maps chosen answer TEXT back onto the Codex question id', () => {
    const pending = { requestId: 'q-1', toolName: 'AskUserQuestion', input: {}, questions: [{ id: 'qid', header: 'Deploy?', question: 'Ship it?', options: ['Yes', 'No'] }] } as any;
    const decision = { behavior: 'allow', updatedInput: { answers: { 'Ship it?': 'Yes' } } } as const;
    expect(buildApprovalResponse('item/tool/requestUserInput', decision, pending)).toEqual({ answers: { qid: { answers: ['Yes'] } } });
  });

  it('permissions allow echoes the requested profile as granted', () => {
    const pending = { requestId: 'p-1', toolName: 'Permissions', input: { permissions: { network: { allowed: true } } } } as any;
    expect(buildApprovalResponse('item/permissions/requestApproval', { behavior: 'allow' }, pending)).toEqual({ permissions: { network: { allowed: true } }, scope: 'turn' });
  });
});
