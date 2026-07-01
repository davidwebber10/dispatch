import { it, expect } from 'vitest';
import { sumTranscriptTokens } from '../../src/sessions/cc-sessions.js';

// A representative Claude Code transcript JSONL with per-message `usage` fields.
const TRANSCRIPT = [
  JSON.stringify({ type: 'summary', summary: 'A prior chat' }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } }),
  JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'on it' }],
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 },
    },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      model: '<synthetic>',
      content: [{ type: 'text', text: 'compacting…' }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 200, output_tokens: 75, cache_read_input_tokens: 30, cache_creation_input_tokens: 0 },
    },
  }),
  'not json at all',
].join('\n');

it('sums input/output/cache tokens across assistant usage lines', () => {
  const stats = sumTranscriptTokens(TRANSCRIPT);
  expect(stats.inputTokens).toBe(310);
  expect(stats.outputTokens).toBe(130);
  expect(stats.cacheReadTokens).toBe(50);
  expect(stats.cacheCreationTokens).toBe(5);
  expect(stats.messageCount).toBe(3);
  // matches the Claude CLI's own token display: input + output + cache_read
  expect(stats.totalTokens).toBe(310 + 130 + 50);
});

it('ignores the synthetic model but keeps its usage in the sum', () => {
  const stats = sumTranscriptTokens(TRANSCRIPT);
  expect(stats.model).toBe('claude-sonnet-4-6');
});

it('returns all-zero stats for empty / unparseable input', () => {
  expect(sumTranscriptTokens('')).toMatchObject({ model: '', totalTokens: 0, messageCount: 0 });
  expect(sumTranscriptTokens('garbage\nmore garbage')).toMatchObject({ model: '', totalTokens: 0, messageCount: 0 });
});
