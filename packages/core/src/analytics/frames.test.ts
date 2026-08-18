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
