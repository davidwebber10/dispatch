import { describe, test, expect } from 'vitest';
import { parseCodexRollout } from '../../src/conversation/codex-transcript.js';

/**
 * Fixtures are real lines from a Codex rollout file
 * (~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl), trimmed for length.
 * Every line has the same envelope: { timestamp, type, payload }.
 */
const line = (o: unknown) => JSON.stringify(o);

const USER = line({
  timestamp: '2026-07-31T04:40:30.231Z',
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'can you see the cell level data' }] },
});
const ASSISTANT = line({
  timestamp: '2026-07-31T04:40:33.771Z',
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I’ll check the Dispatch connector.' }] },
});
const DEVELOPER = line({
  timestamp: '2026-07-31T04:40:29.000Z',
  type: 'response_item',
  payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '## CLI tools available via Dispatch' }] },
});
const FUNCTION_CALL = line({
  timestamp: '2026-07-31T04:40:35.966Z',
  type: 'response_item',
  payload: { type: 'function_call', name: 'list_threads', call_id: 'call_yZq', arguments: '{"limit":5}' },
});
const FUNCTION_OUTPUT = line({
  timestamp: '2026-07-31T04:40:40.100Z',
  type: 'response_item',
  payload: { type: 'function_call_output', call_id: 'call_yZq', output: 'Wall time: 4.29 seconds\nOutput:\n[]' },
});
const CUSTOM_CALL = line({
  timestamp: '2026-07-31T04:41:00.000Z',
  type: 'response_item',
  payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_ag7', input: 'const r = await tools.exec_command({ cmd: "wc -l" })' },
});
const CUSTOM_OUTPUT = line({
  timestamp: '2026-07-31T04:41:02.000Z',
  type: 'response_item',
  payload: {
    type: 'custom_tool_call_output', call_id: 'call_ag7',
    output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: '240 lines' }],
  },
});
// Reasoning carries its content in `encrypted_content`; `summary` is empty on every one of
// the 1553 reasoning lines in the sampled transcript. There is nothing renderable in it.
const REASONING = line({
  timestamp: '2026-07-31T04:40:34.000Z',
  type: 'response_item',
  payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAAA…', id: 'rs_1' },
});
// `event_msg` is the UI event stream and DUPLICATES the response_item family — the sampled
// transcript has 179 `event_msg/agent_message` against exactly 179 assistant messages.
const EVENT_MSG = line({
  timestamp: '2026-07-31T04:40:33.771Z',
  type: 'event_msg',
  payload: { type: 'agent_message', message: 'I’ll check the Dispatch connector.' },
});
const TOKEN_COUNT = line({ timestamp: '2026-07-31T04:40:33.000Z', type: 'event_msg', payload: { type: 'token_count', total: 1234 } });

describe('parseCodexRollout', () => {
  test('reads a human turn', () => {
    expect(parseCodexRollout(USER)).toEqual([
      { kind: 'user', text: 'can you see the cell level data', ts: '2026-07-31T04:40:30.231Z' },
    ]);
  });

  test('reads an assistant turn from output_text', () => {
    expect(parseCodexRollout(ASSISTANT)).toEqual([
      { kind: 'assistant', text: 'I’ll check the Dispatch connector.', ts: '2026-07-31T04:40:33.771Z' },
    ]);
  });

  test('skips the developer role — injected instructions, not the conversation', () => {
    expect(parseCodexRollout(DEVELOPER)).toEqual([]);
  });

  test('reads a function call and its output as a tool pair', () => {
    expect(parseCodexRollout(FUNCTION_CALL)).toEqual([
      { kind: 'tool', toolName: 'list_threads', toolInput: '{"limit":5}', ts: '2026-07-31T04:40:35.966Z' },
    ]);
    expect(parseCodexRollout(FUNCTION_OUTPUT)).toEqual([
      { kind: 'tool-result', text: 'Wall time: 4.29 seconds\nOutput:\n[]', ts: '2026-07-31T04:40:40.100Z' },
    ]);
  });

  test('reads a custom tool call, whose input is a plain string', () => {
    expect(parseCodexRollout(CUSTOM_CALL)).toEqual([
      { kind: 'tool', toolName: 'exec', toolInput: 'const r = await tools.exec_command({ cmd: "wc -l" })', ts: '2026-07-31T04:41:00.000Z' },
    ]);
  });

  test('flattens a custom tool output, whose payload is an array of text blocks', () => {
    expect(parseCodexRollout(CUSTOM_OUTPUT)).toEqual([
      { kind: 'tool-result', text: 'Script completed\n240 lines', ts: '2026-07-31T04:41:02.000Z' },
    ]);
  });

  test('skips reasoning — the summary is always empty and the content is encrypted', () => {
    expect(parseCodexRollout(REASONING)).toEqual([]);
  });

  // This is the one that keeps the transcript from rendering twice. Both families describe
  // the same turn; only `response_item` is read.
  test('skips the event_msg family, which duplicates response_item', () => {
    expect(parseCodexRollout(EVENT_MSG)).toEqual([]);
    expect(parseCodexRollout(TOKEN_COUNT)).toEqual([]);
  });

  test('parses a whole file in order, and survives a garbled line', () => {
    const text = [USER, 'not json {', ASSISTANT, TOKEN_COUNT, FUNCTION_CALL].join('\n');
    expect(parseCodexRollout(text).map((i) => i.kind)).toEqual(['user', 'assistant', 'tool']);
  });

  test('ignores a blank line and an empty payload without throwing', () => {
    expect(parseCodexRollout('\n\n')).toEqual([]);
    expect(parseCodexRollout(line({ timestamp: 'x', type: 'response_item' }))).toEqual([]);
    expect(parseCodexRollout(line({}))).toEqual([]);
  });
});
