import { describe, it, expect } from 'vitest';
import { parseClaudeTranscript, type ConvItem } from '../../src/conversation/transcript.js';

// Synthesized to match the real ~/.claude/projects/<enc>/<id>.jsonl shape.
const FIXTURE = [
  '{"type":"mode","mode":"default","sessionId":"s"}',
  '{"type":"permission-mode","permissionMode":"acceptEdits","sessionId":"s"}',
  '{"type":"user","message":{"role":"user","content":"Fix the bug in app.ts"},"isMeta":false,"timestamp":"2026-06-22T00:00:00Z","uuid":"u1"}',
  '{"type":"user","message":{"role":"user","content":"<system-reminder> noise"},"isMeta":true,"uuid":"m1"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm let me look"}]},"timestamp":"2026-06-22T00:00:01Z","uuid":"a1"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I\'ll fix it."}]},"uuid":"a2"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","id":"t1","input":{"file_path":"/x/app.ts"}}]},"uuid":"a3"}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"done"}]},"uuid":"u2"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Fixed it."}]},"uuid":"a4"}',
].join('\n');

const kinds = (items: ConvItem[]) => items.map((i) => i.kind);

describe('parseClaudeTranscript', () => {
  it('parses the conversation in order, skipping meta + bookkeeping entries', () => {
    const items = parseClaudeTranscript(FIXTURE);
    expect(kinds(items)).toEqual(['user', 'thinking', 'assistant', 'tool', 'tool-result', 'assistant']);
  });

  it('keeps the human prompt (string content) and assistant text', () => {
    const items = parseClaudeTranscript(FIXTURE);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'Fix the bug in app.ts', uuid: 'u1' });
    expect(items.find((i) => i.kind === 'assistant')?.text).toBe("I'll fix it.");
  });

  it('renders tool calls with a friendly title + result', () => {
    const items = parseClaudeTranscript(FIXTURE);
    const tool = items.find((i) => i.kind === 'tool')!;
    expect(tool.toolName).toBe('Edit');
    expect(tool.toolTitle).toBe('Edit app.ts');
    expect(items.find((i) => i.kind === 'tool-result')?.text).toBe('done');
  });

  it('does not emit anything for meta users or mode entries', () => {
    const items = parseClaudeTranscript(FIXTURE);
    expect(items.some((i) => i.text?.includes('system-reminder'))).toBe(false);
  });

  it('skips a partial/garbled trailing line (file mid-write)', () => {
    const items = parseClaudeTranscript(FIXTURE + '\n{"type":"assistant","message":{"role":"assist');
    expect(kinds(items)).toEqual(['user', 'thinking', 'assistant', 'tool', 'tool-result', 'assistant']);
  });

  it('handles an empty/whitespace transcript', () => {
    expect(parseClaudeTranscript('')).toEqual([]);
    expect(parseClaudeTranscript('\n  \n')).toEqual([]);
  });

  it('maps a Bash tool call detail to its command', () => {
    const line = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}';
    const [tool] = parseClaudeTranscript(line);
    expect(tool).toMatchObject({ kind: 'tool', toolName: 'Bash', toolDetail: 'npm test' });
  });
});

// A message sent WHILE the assistant is mid-turn is persisted NOT as a `user` turn but as a
// `queued_command` attachment (verified against real transcripts — its text/images live in
// attachment.prompt). Without rendering these, every mid-turn post vanishes when the view
// rebuilds from disk, even though the live view showed it via the daemon's send-echo.
describe('mid-turn posts (queued_command attachments)', () => {
  it('renders a mid-turn text post as the user turn it is', () => {
    const line = '{"type":"attachment","attachment":{"type":"queued_command","commandMode":"prompt","prompt":"fix the sort icon"},"timestamp":"2026-07-20T00:00:00Z","uuid":"q1"}';
    expect(parseClaudeTranscript(line)).toEqual([
      { kind: 'user', text: 'fix the sort icon', ts: '2026-07-20T00:00:00Z', uuid: 'q1' },
    ]);
  });

  it('renders a mid-turn post with a pasted screenshot as user text + a user-attached image', () => {
    const prompt = JSON.stringify([
      { type: 'text', text: 'like this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
    const items = parseClaudeTranscript(`{"type":"attachment","attachment":{"type":"queued_command","commandMode":"prompt","prompt":${prompt}},"uuid":"q2"}`);
    expect(items.map((i) => i.kind)).toEqual(['user', 'image']);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'like this', uuid: 'q2' });
    expect(items[1]).toMatchObject({ kind: 'image', imageUrl: 'data:image/png;base64,AAAA', imageFromUser: true, uuid: 'q2' });
  });

  it('ignores every other attachment kind (hook output, task reminders, listings, …)', () => {
    expect(parseClaudeTranscript('{"type":"attachment","attachment":{"type":"hook_success","content":"x"}}')).toEqual([]);
    expect(parseClaudeTranscript('{"type":"attachment","attachment":{"type":"task_reminder","content":"x"}}')).toEqual([]);
  });
});
