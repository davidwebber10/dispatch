import { describe, it, expect } from 'vitest';
import { GrokTranslator, buildPermissionResponse, type GrokAction } from './grok-translate.js';
import * as fx from './grok-frames.fixture.js';

/** Only the `event` payloads (drops busy/idle/approval control actions). */
function events(actions: GrokAction[]): any[] {
  return actions.filter((a) => a.kind === 'event').map((a) => (a as any).event);
}
const kinds = (actions: GrokAction[]) => actions.map((a) => a.kind);

describe('GrokTranslator — ACP session/update → Claude-shaped stream', () => {
  it('init → a system/init event carrying the model for the chat header', () => {
    const t = new GrokTranslator();
    expect(t.init('grok-4.6')).toEqual([{ kind: 'event', event: { type: 'system', subtype: 'init', model: 'grok-4.6' } }]);
  });

  it('agent_message_chunk deltas → message_start then ONE text block streamed by deltas', () => {
    const t = new GrokTranslator();
    const first = events(t.translate(fx.agentMsgChunk1 as any));
    expect(first[0]).toEqual({ type: 'stream_event', event: { type: 'message_start' } });
    expect(first[1]).toMatchObject({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
    expect(first[2]).toMatchObject({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PROBE' } } });
    // The second chunk continues the SAME block — no new start.
    const second = events(t.translate(fx.agentMsgChunk2 as any));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '-OK' } } });
  });

  it('agent_thought_chunk → a thinking block, distinct from the text block', () => {
    const t = new GrokTranslator();
    const thought = events(t.translate(fx.thoughtChunk as any));
    expect(thought[0]).toEqual({ type: 'stream_event', event: { type: 'message_start' } });
    expect(thought[1]).toMatchObject({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });
    expect(thought[2]).toMatchObject({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The user wants' } } });
    // Prose after thinking closes the thinking block and opens text at the NEXT index.
    const text = events(t.translate(fx.agentMsgChunk1 as any));
    expect(text[0]).toMatchObject({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    expect(text[1]).toMatchObject({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } });
  });

  it('a live user_message_chunk is ignored (the manager synthesizes the echo)', () => {
    const t = new GrokTranslator();
    expect(t.translate(fx.userMsgChunkLive as any)).toEqual([]);
  });

  it('tool_call → assistant tool_use named from the x.ai/tool meta, input from rawInput', () => {
    const t = new GrokTranslator();
    const out = events(t.translate(fx.toolCall as any));
    expect(out[0]).toMatchObject({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-8c526644-0', name: 'run_terminal_command' }] },
    });
    expect(out[0].message.content[0].input).toMatchObject({ command: 'echo probe-tool-ok' });
  });

  it('a tool_call closes any open prose block first, so later prose gets a NEW block', () => {
    const t = new GrokTranslator();
    t.translate(fx.agentMsgChunk1 as any); // opens text at index 0
    const during = events(t.translate(fx.toolCall as any));
    expect(during[0]).toMatchObject({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    const after = events(t.translate(fx.agentMsgChunk2 as any));
    expect(after[0]).toMatchObject({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } });
  });

  it('tool_call_update: in_progress emits nothing; completed emits ONE tool_result', () => {
    const t = new GrokTranslator();
    t.translate(fx.toolCall as any);
    expect(events(t.translate(fx.toolCallUpdateProgress as any))).toEqual([]);
    const done = events(t.translate(fx.toolCallUpdateCompleted as any));
    expect(done[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-8c526644-0', is_error: false }] },
    });
    expect(done[0].message.content[0].content).toContain('probe-tool-ok');
    // A duplicate completed update must not emit a second result.
    expect(events(t.translate(fx.toolCallUpdateCompleted as any))).toEqual([]);
  });

  it('a failed tool_call_update → tool_result with is_error', () => {
    const t = new GrokTranslator();
    t.translate(fx.toolCall as any);
    const failed = JSON.parse(JSON.stringify(fx.toolCallUpdateCompleted));
    failed.params.update.status = 'failed';
    const out = events(t.translate(failed as any));
    expect(out[0].message.content[0].is_error).toBe(true);
  });

  it('turn_completed → a result footer with the turn usage, then idle', () => {
    const t = new GrokTranslator();
    const out = t.translate(fx.turnCompleted as any);
    expect(kinds(out)).toEqual(['event', 'idle']);
    expect(events(out)[0]).toMatchObject({
      type: 'result', subtype: 'grok_turn', is_error: false,
      usage: { input_tokens: 40247, output_tokens: 125 },
    });
  });

  it('a turn whose last agent prose asks a question ends in needs-help, not idle', () => {
    const t = new GrokTranslator();
    const chunk = JSON.parse(JSON.stringify(fx.agentMsgChunk1));
    chunk.params.update.content.text = 'Rewired the rail. Does that look right to you?';
    t.translate(chunk as any);
    const out = t.translate(fx.turnCompleted as any);
    expect(kinds(out)).toContain('needs-help');
    expect(kinds(out)).not.toContain('idle');
    const boundary = out.find((a) => a.kind === 'needs-help') as any;
    expect(boundary.summary).toContain('Does that look right');
  });

  it('the closing prose is consumed at the boundary — it cannot leak into the next turn', () => {
    const t = new GrokTranslator();
    const chunk = JSON.parse(JSON.stringify(fx.agentMsgChunk1));
    chunk.params.update.content.text = 'Does that look right to you?';
    t.translate(chunk as any);
    t.translate(fx.turnCompleted as any);
    // Next turn ends with no prose at all — must settle idle, not re-fire the stale question.
    const out = t.translate(fx.turnCompleted as any);
    expect(kinds(out)).toContain('idle');
    expect(kinds(out)).not.toContain('needs-help');
  });

  it('idle carries the completed prose as `summary` so a real outcome line persists', () => {
    const t = new GrokTranslator();
    t.translate(fx.agentMsgChunk1 as any);
    t.translate(fx.agentMsgChunk2 as any);
    const idle = t.translate(fx.turnCompleted as any).find((a) => a.kind === 'idle') as any;
    expect(idle.summary).toBe('PROBE-OK');
  });

  it('response_completed → a zero-content assistant usage event for the context bar', () => {
    const t = new GrokTranslator();
    const out = events(t.translate(fx.responseCompleted as any));
    expect(out[0]).toMatchObject({
      type: 'assistant',
      message: { role: 'assistant', content: [], usage: { input_tokens: 16952 - 3072, cache_read_input_tokens: 3072, output_tokens: 45 } },
    });
  });
});

describe('GrokTranslator — session/load replay (the resume backfill)', () => {
  it('replayed user/agent chunks become WHOLE events, not stream deltas', () => {
    const t = new GrokTranslator();
    const user = events(t.translate(fx.userMsgChunkReplay as any, { replay: true }));
    expect(user[0]).toMatchObject({ type: 'user', message: { role: 'user', content: [{ type: 'text' }] } });
    expect(user[0].message.content[0].text).toContain('grok-probe-perm');
    const agent = events(t.translate(fx.agentMsgChunkReplay as any, { replay: true }));
    expect(agent[0]).toMatchObject({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text' }] } });
    expect(agent[0].message.content[0].text).toContain('with the shell');
  });

  it('a replayed turn_completed emits NO actions — no idle, no result footer, no usage rows', () => {
    const t = new GrokTranslator();
    expect(t.translate(fx.turnCompleted as any, { replay: true })).toEqual([]);
  });

  it('replayed tool frames still pair tool_use with tool_result', () => {
    const t = new GrokTranslator();
    const use = events(t.translate(fx.toolCall as any, { replay: true }));
    expect(use[0].message.content[0]).toMatchObject({ type: 'tool_use', id: 'call-8c526644-0' });
    const result = events(t.translate(fx.toolCallUpdateCompleted as any, { replay: true }));
    expect(result[0].message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call-8c526644-0' });
  });
});

describe('GrokTranslator — the permission membrane', () => {
  it('session/request_permission → an approval action with an allow auto-answer', () => {
    const t = new GrokTranslator();
    const out = t.translate(fx.requestPermission as any);
    expect(out).toHaveLength(1);
    const a = out[0] as any;
    expect(a.kind).toBe('approval');
    expect(a.requestId).toBe(11);
    expect(a.alwaysSurface).toBe(false);
    expect(a.pending.toolName).toBe('run_terminal_command');
    expect(a.pending.input).toMatchObject({ command: 'rm -rf /tmp/x' });
    // Auto-allow selects the first allow_* option, in the ACP response envelope.
    expect(a.autoApprove).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });

  it('buildPermissionResponse: allow selects an allow option, deny a reject option', () => {
    const options = (fx.requestPermission as any).params.options;
    expect(buildPermissionResponse({ behavior: 'allow' }, options)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(buildPermissionResponse({ behavior: 'deny', message: 'no' }, options)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
  });

  it('buildPermissionResponse: deny with NO reject option cancels instead', () => {
    const options = [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }];
    expect(buildPermissionResponse({ behavior: 'deny' }, options)).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});
