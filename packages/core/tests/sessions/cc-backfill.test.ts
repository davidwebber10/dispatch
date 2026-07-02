import { it, expect } from 'vitest';
import { backfillEventsFromTranscript } from '../../src/sessions/cc-sessions.js';

// A representative Claude Code transcript JSONL (one entry per line). Each kept entry
// carries a `uuid` — modern Claude Code writes one per line/content-block, verified against
// a real captured transcript — matching the identity the live stream-json protocol also
// carries on the equivalent event (see manager.ts / useStructuredChat.ts's 'assistant'/'user'
// handlers, which read `event.uuid`).
const TRANSCRIPT = [
  JSON.stringify({ type: 'summary', summary: 'A prior chat' }),
  JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'injected context' } }),
  JSON.stringify({ type: 'user', uuid: 'u-prompt', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } }),
  JSON.stringify({ type: 'assistant', uuid: 'u-tool', message: { content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } }),
  JSON.stringify({ type: 'user', uuid: 'u-result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file.txt' }] } }),
  JSON.stringify({ type: 'assistant', isSidechain: true, uuid: 'u-side', message: { content: [{ type: 'text', text: 'subagent noise' }] } }),
  JSON.stringify({ type: 'assistant', uuid: 'u-empty', message: { content: [] } }), // empty — dropped
  'not json at all',
].join('\n');

it('keeps user+assistant turns as structured events and drops bookkeeping entries', () => {
  const events = backfillEventsFromTranscript(TRANSCRIPT) as any[];
  // summary, isMeta user, isSidechain assistant, empty assistant, garbage → all dropped
  expect(events).toHaveLength(3);
  expect(events[0]).toEqual({ type: 'user', uuid: 'u-prompt', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } });
  // tool_use blocks are preserved inside the assistant message (the View renders them)
  expect(events[1].type).toBe('assistant');
  expect(JSON.stringify(events[1])).toContain('tool_use');
  // tool_result user turn is preserved
  expect(JSON.stringify(events[2])).toContain('tool_result');
});

// Identity threading (root fix for the tool-ordering regression, a6ff2ef follow-up): the
// client dedups/anchors a REST-paged item against a ws-replayed one by this uuid — it only
// works if a resumed/revived thread's replayed backfill carries the SAME uuid the transcript
// itself has on disk (which conversation/transcript.ts's REST parser also reads).
it("threads each entry's transcript uuid onto the emitted event", () => {
  const events = backfillEventsFromTranscript(TRANSCRIPT) as any[];
  expect(events.map((e: any) => e.uuid)).toEqual(['u-prompt', 'u-tool', 'u-result']);
});

it('shapes match the live structured stream (type + message [+ uuid when present])', () => {
  const events = backfillEventsFromTranscript(TRANSCRIPT) as any[];
  for (const e of events) {
    expect(Object.keys(e).sort()).toEqual(['message', 'type', 'uuid']);
  }
  // An entry with no uuid on disk (legacy transcript) omits the key rather than emitting
  // `uuid: undefined` — keeps back-compat with any consumer doing a strict key-set check.
  const noUuid = backfillEventsFromTranscript(
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'legacy' }] } }),
  ) as any[];
  expect(Object.keys(noUuid[0]).sort()).toEqual(['message', 'type']);
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

// Claude Code transcripts never write a trailing `result` line, so a revived thread's
// replay would otherwise end on `assistant` with nothing to clear the client's `busy`
// flag (stuck "Working…" spinner after a daemon restart). See useStructuredChat.ts's
// `subtype === 'backfill'` handler, which swallows this synthetic event.
it('appends a synthetic backfill result when the transcript tail is a completed assistant turn', () => {
  const transcript = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
  ].join('\n');
  const events = backfillEventsFromTranscript(transcript) as any[];
  expect(events).toHaveLength(3);
  expect(events[2]).toEqual({ type: 'result', subtype: 'backfill', is_error: false });
});

it('does NOT append a synthetic result when the tail has a dangling tool_use (mid-turn, interrupted)', () => {
  const transcript = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } }),
  ].join('\n');
  const events = backfillEventsFromTranscript(transcript) as any[];
  expect(events).toHaveLength(2);
  expect(events.some((e: any) => e.type === 'result')).toBe(false);
});

it('does NOT append a synthetic result when the tail ends on a user turn', () => {
  const transcript = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } }),
  ].join('\n');
  const events = backfillEventsFromTranscript(transcript) as any[];
  expect(events).toHaveLength(2);
  expect(events.some((e: any) => e.type === 'result')).toBe(false);
});
