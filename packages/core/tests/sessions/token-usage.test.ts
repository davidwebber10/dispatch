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

// Claude Code writes one JSONL line per content block (thinking/text/tool_use) within a
// single assistant message, repeating the IDENTICAL whole-message `usage` on every line.
// A naive per-line sum counts that message's usage once per line — this is the bug that
// inflated real transcripts by ~2x (114/146 messages were multi-line in the measured case).
const MULTI_BLOCK_TRANSCRIPT = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } }),
  // Three lines, ONE logical message (shared id), split across thinking/text/tool_use blocks.
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_shared_1',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'thinking', thinking: 'hmm' }],
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 50 },
    },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_shared_1',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'on it' }],
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 50 },
    },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_shared_1',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }],
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 50 },
    },
  }),
  // A second, distinct message — must still be counted (dedup is per-id, not "only the first ever").
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_shared_2',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 300, output_tokens: 75, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 },
    },
  }),
].join('\n');

it('dedups a message split across multiple JSONL lines by message.id (counts its usage exactly once)', () => {
  const stats = sumTranscriptTokens(MULTI_BLOCK_TRANSCRIPT);
  // Without dedup this would be 3x the first message's usage plus the second: input 3300,
  // output 675, etc. With dedup, msg_shared_1 counts once + msg_shared_2 counts once.
  expect(stats.inputTokens).toBe(1000 + 300);
  expect(stats.outputTokens).toBe(200 + 75);
  expect(stats.cacheReadTokens).toBe(500 + 20);
  expect(stats.cacheCreationTokens).toBe(50 + 0);
  expect(stats.messageCount).toBe(2); // two unique messages, not five usage-bearing lines
});

it('exposes outputTokens separately from the cumulative totalTokens (Done card reads this)', () => {
  const stats = sumTranscriptTokens(MULTI_BLOCK_TRANSCRIPT);
  expect(stats.outputTokens).toBe(275);
  expect(stats.totalTokens).not.toBe(stats.outputTokens); // cumulative includes input+cache too
  expect(stats.totalTokens).toBe(stats.inputTokens + stats.outputTokens + stats.cacheReadTokens);
});
