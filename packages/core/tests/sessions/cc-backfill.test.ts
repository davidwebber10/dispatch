import { it, expect } from 'vitest';
import { backfillEventsFromTranscript } from '../../src/sessions/cc-sessions.js';

// A representative Claude Code transcript JSONL (one entry per line).
const TRANSCRIPT = [
  JSON.stringify({ type: 'summary', summary: 'A prior chat' }),
  JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'injected context' } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file.txt' }] } }),
  JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [] } }), // empty — dropped
  'not json at all',
].join('\n');

it('keeps user+assistant turns as structured events and drops bookkeeping entries', () => {
  const events = backfillEventsFromTranscript(TRANSCRIPT) as any[];
  // summary, isMeta user, isSidechain assistant, empty assistant, garbage → all dropped
  expect(events).toHaveLength(3);
  expect(events[0]).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } });
  // tool_use blocks are preserved inside the assistant message (the View renders them)
  expect(events[1].type).toBe('assistant');
  expect(JSON.stringify(events[1])).toContain('tool_use');
  // tool_result user turn is preserved
  expect(JSON.stringify(events[2])).toContain('tool_result');
});

it('shapes match the live structured stream (type + message only)', () => {
  const events = backfillEventsFromTranscript(TRANSCRIPT) as any[];
  for (const e of events) {
    expect(Object.keys(e).sort()).toEqual(['message', 'type']);
  }
});

it('caps to the most recent <limit> entries', () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `m${i}` }] } }),
  ).join('\n');
  const events = backfillEventsFromTranscript(many, 3) as any[];
  expect(events).toHaveLength(3);
  expect(JSON.stringify(events[0])).toContain('m7'); // newest 3: m7,m8,m9
  expect(JSON.stringify(events[2])).toContain('m9');
});

it('returns [] for empty / unparseable input', () => {
  expect(backfillEventsFromTranscript('')).toEqual([]);
  expect(backfillEventsFromTranscript('garbage\nmore garbage')).toEqual([]);
});
