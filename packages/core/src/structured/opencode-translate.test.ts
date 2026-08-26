import { describe, it, expect } from 'vitest';
import { GrokTranslator, type GrokAction } from './grok-translate.js';
import * as fx from './opencode-frames.fixture.js';

/**
 * The OpenCode dialect of the shared ACP translator (see grok-manager.ts header): the same
 * GrokTranslator instance, exercised with frames captured from a REAL `opencode acp` session
 * (opencode-frames.fixture.ts). What differs from Grok — late-arriving tool input,
 * usage_update, the response-driven turn boundary — is exactly what these tests pin down.
 */

const events = (as: GrokAction[]) => as.filter((a): a is Extract<GrokAction, { kind: 'event' }> => a.kind === 'event').map((a) => a.event as any);

describe('GrokTranslator — OpenCode dialect', () => {
  it('tool_call → tool_use; the in_progress update re-emits it with the REAL input', () => {
    const t = new GrokTranslator();
    const first = events(t.translate(fx.toolCall as any));
    expect(first[0].message.content[0]).toMatchObject({ type: 'tool_use', id: 'call_9cb2dac0', name: 'bash', input: { cwd: '/tmp/oc-probe' } });

    const refreshed = events(t.translate(fx.toolCallInProgress as any));
    expect(refreshed[0].message.content[0]).toMatchObject({
      type: 'tool_use',
      id: 'call_9cb2dac0',
      name: 'bash', // the ORIGINAL tool name, not the update's human title
      input: { command: 'echo dispatch-probe-ok' },
    });
  });

  it('completed update → one tool_result, and repeats emit nothing', () => {
    const t = new GrokTranslator();
    t.translate(fx.toolCall as any);
    const done = events(t.translate(fx.toolCallCompleted as any));
    expect(done[0].message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_9cb2dac0', is_error: false });
    expect(done[0].message.content[0].content).toContain('dispatch-probe-ok');
    expect(t.translate(fx.toolCallCompleted as any)).toEqual([]);
    // After the result, a straggling in_progress refresh must not re-open the tool.
    expect(t.translate(fx.toolCallInProgress as any)).toEqual([]);
  });

  it('usage_update → context-bar assistant frame with the REAL window and the init model', () => {
    const t = new GrokTranslator();
    t.init('openrouter/z-ai/glm-5.2');
    const out = events(t.translate(fx.usageUpdate as any));
    expect(out[0]).toMatchObject({
      type: 'assistant',
      context_window: 1048576,
      message: { role: 'assistant', model: 'openrouter/z-ai/glm-5.2', content: [], usage: { input_tokens: 8736, output_tokens: 0 } },
    });
  });

  /*
   * The gauge/bill split. usage_update's input_tokens is the WHOLE current
   * context re-reported on every publish — a gauge. The recorder must never sum
   * it, so the frame is tagged context_fill (frames.ts returns null for it).
   * The BILLABLE per-turn figure arrives once, in the session/prompt response,
   * and promptResult re-emits it as a plain assistant usage frame with the cache
   * split, stamped with the model — that frame is what analytics records.
   * Before this split, every OpenCode turn recorded its context size as input,
   * zero output, and zero cache.
   */
  it('tags the usage_update frame context_fill, so analytics skips the gauge', () => {
    const t = new GrokTranslator();
    t.init('openrouter/z-ai/glm-5.2');
    const out = events(t.translate(fx.usageUpdate as any));
    expect(out[0].subtype).toBe('context_fill');
  });

  it('promptResult emits the real per-turn usage as an assistant frame with the cache split', () => {
    const t = new GrokTranslator();
    t.init('openrouter/z-ai/glm-5.2');
    const frames = events(t.promptResult(fx.promptResponse));
    const usageIdx = frames.findIndex((e) => e.type === 'assistant' && e.message?.usage);
    const resultIdx = frames.findIndex((e) => e.type === 'result');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    // The frame must land while the turn is still open — before the result footer.
    expect(usageIdx).toBeLessThan(resultIdx);
    const usageFrame = frames[usageIdx];
    expect(usageFrame).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'openrouter/z-ai/glm-5.2',
        content: [],
        usage: { input_tokens: 1311, cache_read_input_tokens: 7425, output_tokens: 6 },
      },
    });
    // NOT a gauge — the recorder must count this one.
    expect(usageFrame.subtype).toBeUndefined();
  });

  it('promptResult with no usage numbers emits no usage frame', () => {
    const t = new GrokTranslator();
    const frames = events(t.promptResult({ stopReason: 'end_turn', usage: {} }));
    expect(frames.some((e) => e.type === 'assistant' && e.message?.usage)).toBe(false);
  });

  it('promptResult → result footer with usage + the cost DELTA, then idle with the prose', () => {
    const t = new GrokTranslator();
    t.translate(fx.agentMessageChunk as any);
    t.translate(fx.usageUpdate as any);
    const actions = t.promptResult(fx.promptResponse);
    const result = events(actions).find((e) => e.type === 'result');
    expect(result).toMatchObject({
      subtype: 'acp_turn',
      is_error: false,
      usage: { input_tokens: 1311, output_tokens: 6 },
      total_cost_usd: 0.0024469632,
    });
    const idle = actions.find((a) => a.kind === 'idle') as any;
    expect(idle.summary).toBe('PROBE-DONE');

    // Second turn with no new usage_update: the cumulative cost was already reported —
    // the footer must NOT charge it again.
    const second = events(t.promptResult(fx.promptResponse)).find((e) => e.type === 'result') as any;
    expect(second.total_cost_usd).toBeUndefined();
  });

  /*
   * Resume safety. usage_update's cost is SESSION-cumulative. A resumed session
   * builds a fresh translator whose baseline is zero, so the first live
   * usage_update would otherwise report the ENTIRE prior session's dollars as
   * one turn's delta — dollars analytics already booked, row by row, before the
   * restart. The first turn after a resume seeds the baseline and bills
   * nothing; growth after that is billable again.
   */
  it('a resumed session does not bill the pre-resume cumulative cost as one delta', () => {
    const t = new GrokTranslator();
    t.init('openrouter/z-ai/glm-5.2', { resumed: true });
    t.translate(fx.usageUpdate as any); // cumulative 0.0024469632 — includes pre-resume turns
    const first = events(t.promptResult(fx.promptResponse)).find((e) => e.type === 'result') as any;
    expect(first.total_cost_usd).toBeUndefined();

    const grown = JSON.parse(JSON.stringify(fx.usageUpdate));
    grown.params.update.cost.amount = 0.004;
    t.translate(grown as any);
    const second = events(t.promptResult(fx.promptResponse)).find((e) => e.type === 'result') as any;
    expect(second.total_cost_usd).toBeCloseTo(0.004 - 0.0024469632, 9);
  });

  it('a replayed usage_update seeds the cost baseline and emits nothing', () => {
    const t = new GrokTranslator();
    expect(t.translate(fx.usageUpdate as any, { replay: true })).toEqual([]);
    const result = events(t.promptResult(fx.promptResponse)).find((e) => e.type === 'result') as any;
    expect(result.total_cost_usd).toBeUndefined();
  });

  it('a closing question in the prose settles promptResult as needs-help, not idle', () => {
    const t = new GrokTranslator();
    t.translate({
      method: 'session/update',
      params: { sessionId: 'ses_oc1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Should I also update the README?' } } },
    } as any);
    const actions = t.promptResult({ stopReason: 'end_turn', usage: {} });
    const help = actions.find((a) => a.kind === 'needs-help') as any;
    expect(help).toBeTruthy();
    expect(help.ask).toContain('README');
  });

  it('an error stopReason marks the footer is_error', () => {
    const t = new GrokTranslator();
    const result = events(t.promptResult({ stopReason: 'error', usage: {} })).find((e) => e.type === 'result') as any;
    expect(result.is_error).toBe(true);
  });
});
