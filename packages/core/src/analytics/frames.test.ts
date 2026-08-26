import { describe, it, expect } from 'vitest';
import { usageFromFrame, toolCallsInFrame } from './frames.js';

const claudeFrame = {
  type: 'assistant',
  message: {
    model: 'claude-opus-5',
    content: [{ type: 'text', text: 'hi' }],
    usage: { input_tokens: 12, output_tokens: 30, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 },
  },
};

describe('usageFromFrame', () => {
  it('reads Claude/Codex assistant usage', () => {
    expect(usageFromFrame(claudeFrame)).toEqual({
      input: 12, output: 30, cacheRead: 900, cacheCreate: 40, model: 'claude-opus-5',
    });
  });

  it('treats missing usage counters as zero, not NaN', () => {
    const u = usageFromFrame({ type: 'assistant', message: { usage: { output_tokens: 5 } } })!;
    expect(u).toEqual({ input: 0, output: 5, cacheRead: 0, cacheCreate: 0, model: '' });
  });

  it('returns null for a frame with no usage block', () => {
    expect(usageFromFrame({ type: 'system', subtype: 'init' })).toBeNull();
    expect(usageFromFrame({ type: 'assistant', message: { content: [] } })).toBeNull();
    expect(usageFromFrame(null)).toBeNull();
    expect(usageFromFrame('nonsense')).toBeNull();
  });

  /*
   * '<synthetic>' is Claude Code's placeholder model on error/no-op assistant
   * messages. It is not a model: letting it through mis-labelled whole turns
   * (setModel takes the LAST frame's model) and pty-claude tails, sending
   * millions of real tokens to an unpriceable key. The usage counts; the label
   * is dropped so the turn keeps the real model another frame named.
   */
  it('drops the <synthetic> placeholder model but keeps its usage', () => {
    const u = usageFromFrame({
      type: 'assistant',
      message: { model: '<synthetic>', content: [], usage: { input_tokens: 3, output_tokens: 4 } },
    })!;
    expect(u.model).toBe('');
    expect(u.output).toBe(4);
  });

  /*
   * A context_fill frame (grok-translate.ts usageUpdate) is a GAUGE: its
   * input_tokens is the whole current context, re-reported every time OpenCode
   * publishes the fill. Summing gauge readings as billable usage inflated every
   * OpenCode turn's input and drowned the real per-turn figure that arrives at
   * the turn boundary. The gauge drives the web's context bar only.
   */
  it('returns null for a context_fill gauge frame', () => {
    expect(usageFromFrame({
      type: 'assistant',
      subtype: 'context_fill',
      message: { role: 'assistant', content: [], usage: { input_tokens: 8736, output_tokens: 0 } },
    })).toBeNull();
  });
});

describe('toolCallsInFrame', () => {
  it('counts tool_use blocks', () => {
    expect(toolCallsInFrame({ type: 'assistant', message: { content: [
      { type: 'text', text: 'a' }, { type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Bash' },
    ] } })).toBe(2);
  });

  it('returns 0 when there is no content array', () => {
    expect(toolCallsInFrame({ type: 'result' })).toBe(0);
    expect(toolCallsInFrame(null)).toBe(0);
  });
});
