import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RunStreamParser, runEventToStep, type RunEvent } from '../../src/agents/run-stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(__dirname, '../fixtures/claude-stream.jsonl'), 'utf8');
const codexFixture = fs.readFileSync(path.join(__dirname, '../fixtures/codex-stream.jsonl'), 'utf8');

function parseAll(text: string, chunker?: (s: string) => string[], provider: 'claude-code' | 'codex' = 'claude-code'): RunEvent[] {
  const p = new RunStreamParser(provider);
  const events: RunEvent[] = [];
  for (const chunk of chunker ? chunker(text) : [text]) events.push(...p.feed(chunk));
  events.push(...p.flush());
  return events;
}

describe('RunStreamParser (claude stream-json)', () => {
  it('extracts an init event with model, cwd and session id', () => {
    const events = parseAll(fixture);
    const init = events.find((e) => e.kind === 'init');
    expect(init).toBeDefined();
    if (init?.kind === 'init') {
      expect(init.model).toBe('claude-opus-4-8[1m]');
      expect(init.cwd).toBeTruthy();
      expect(init.sessionId).toMatch(/[0-9a-f-]{36}/);
      expect(init.tools?.length).toBeGreaterThan(0);
    }
  });

  it('extracts assistant text turns', () => {
    const texts = parseAll(fixture).filter((e) => e.kind === 'assistant-text');
    expect(texts.length).toBeGreaterThan(0);
    expect((texts[0] as any).text).toContain("I'll create the file");
  });

  it('extracts tool_use events (Write, Bash)', () => {
    const tools = parseAll(fixture).filter((e) => e.kind === 'tool-use') as Extract<RunEvent, { kind: 'tool-use' }>[];
    const names = tools.map((t) => t.name);
    expect(names).toContain('Write');
    expect(names).toContain('Bash');
    const write = tools.find((t) => t.name === 'Write')!;
    expect((write.input as any).file_path).toContain('hello.txt');
  });

  it('extracts tool_result events', () => {
    const results = parseAll(fixture).filter((e) => e.kind === 'tool-result');
    expect(results.length).toBeGreaterThan(0);
    expect((results[0] as any).content).toContain('File created successfully');
  });

  it('extracts exactly one final result with cost, tokens, turns', () => {
    const results = parseAll(fixture).filter((e) => e.kind === 'result') as Extract<RunEvent, { kind: 'result' }>[];
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.isError).toBe(false);
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.numTurns).toBe(3);
    expect(r.totalTokens).toBeGreaterThan(0);
    expect(r.result).toContain('hello.txt');
  });

  it('is robust to arbitrary chunk boundaries (feed char-by-char)', () => {
    const whole = parseAll(fixture);
    const charByChar = parseAll(fixture, (s) => s.split(''));
    expect(charByChar.map((e) => e.kind)).toEqual(whole.map((e) => e.kind));
  });

  it('tolerates CRLF line endings (PTY framing)', () => {
    const crlf = fixture.replace(/\n/g, '\r\n');
    expect(parseAll(crlf).map((e) => e.kind)).toEqual(parseAll(fixture).map((e) => e.kind));
  });

  it('skips non-JSON / garbage lines without throwing', () => {
    const events = parseAll('garbage not json\n{"type":"system","subtype":"init","model":"x"}\n\n{bad json\n');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('init');
  });
});

describe('RunStreamParser (codex exec --json)', () => {
  it('extracts init (thread id), shell commands, agent message, file change and a final result with tokens', () => {
    const events = parseAll(codexFixture, undefined, 'codex');
    const init = events.find((e) => e.kind === 'init');
    expect(init).toBeDefined();
    if (init?.kind === 'init') expect(init.sessionId).toMatch(/[0-9a-f-]{36}/);

    const tools = events.filter((e) => e.kind === 'tool-use') as Extract<RunEvent, { kind: 'tool-use' }>[];
    expect(tools.some((t) => t.name === 'shell')).toBe(true);
    expect(tools.some((t) => t.name === 'file_change')).toBe(true);

    expect(events.some((e) => e.kind === 'assistant-text')).toBe(true);

    const result = events.find((e) => e.kind === 'result') as Extract<RunEvent, { kind: 'result' }> | undefined;
    expect(result).toBeDefined();
    expect(result!.totalTokens).toBeGreaterThan(0);
  });

  it('is robust to char-by-char chunking', () => {
    const whole = parseAll(codexFixture, undefined, 'codex');
    const split = parseAll(codexFixture, (s) => s.split(''), 'codex');
    expect(split.map((e) => e.kind)).toEqual(whole.map((e) => e.kind));
  });
});

describe('runEventToStep', () => {
  it('maps a Write tool_use to a friendly titled timeline step', () => {
    const step = runEventToStep({ kind: 'tool-use', name: 'Write', input: { file_path: '/a/b/hello.txt', content: 'hi' } });
    expect(step.title).toBe('Write hello.txt');
    expect(step.timeline).toBe(true);
  });

  it('maps a Bash tool_use detail to the command', () => {
    const step = runEventToStep({ kind: 'tool-use', name: 'Bash', input: { command: 'npm test' } });
    expect(step.title).toBe('Bash');
    expect(step.detail).toBe('npm test');
  });

  it('maps TodoWrite (todos) to a Plan step carrying the todo list', () => {
    const step = runEventToStep({ kind: 'todos', todos: [{ content: 'do x', status: 'in_progress' }] });
    expect(step.kind).toBe('todos');
    expect(step.title).toBe('Plan');
    expect(step.todos).toHaveLength(1);
    expect(step.timeline).toBe(true);
  });

  it('maps a successful result to a Completed step, error to Failed', () => {
    expect(runEventToStep({ kind: 'result', isError: false }).title).toBe('Completed');
    expect(runEventToStep({ kind: 'result', isError: true }).status).toBe('error');
  });

  it('keeps thinking and tool-result off the timeline', () => {
    expect(runEventToStep({ kind: 'thinking' }).timeline).toBe(false);
    expect(runEventToStep({ kind: 'tool-result', content: 'x' }).timeline).toBe(false);
  });
});
