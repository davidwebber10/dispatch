import { describe, it, expect } from 'vitest';
import { parseClaudeTranscript } from './transcript';

// The Grok/ACP transcript shape: thinking blocks land BETWEEN a tool_use and its
// tool_result (each ACP update is appended as its own JSONL line in arrival order).
// The web can only pair an id-less call with an id-less result by array adjacency, so
// this shape used to pair nothing — every reloaded Grok tool call rendered "running…"
// forever. The parser must therefore carry the ids through on both sides.
const line = (o: unknown) => JSON.stringify(o);

describe('parseClaudeTranscript tool ids', () => {
  it('carries tool_use id and tool_result tool_use_id (interleaved Grok shape)', () => {
    const text = [
      line({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'run_terminal_command', input: { command: 'ls' } }] } }),
      line({ type: 'assistant', uuid: 'u2', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'checking the output…' }] } }),
      line({ type: 'user', uuid: 'u3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file-a\nfile-b' }] } }),
    ].join('\n');

    const items = parseClaudeTranscript(text);
    const tool = items.find((i) => i.kind === 'tool');
    const result = items.find((i) => i.kind === 'tool-result');
    expect(tool?.toolId).toBe('call_1');
    expect(result?.toolId).toBe('call_1');
    // Non-adjacent on purpose: the thinking item sits between them.
    expect(items.map((i) => i.kind)).toEqual(['tool', 'thinking', 'tool-result']);
  });

  it('leaves toolId undefined when the blocks carry no ids', () => {
    const text = [
      line({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }] } }),
      line({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', content: '/tmp' }] } }),
    ].join('\n');

    const items = parseClaudeTranscript(text);
    expect(items.find((i) => i.kind === 'tool')?.toolId).toBeUndefined();
    expect(items.find((i) => i.kind === 'tool-result')?.toolId).toBeUndefined();
  });
});
