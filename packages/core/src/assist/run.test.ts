import { describe, it, expect } from 'vitest';
import { createAssistRunner, parseClaudeJson, transcriptOf } from './run.js';

describe('assist runner (2026-11-07)', () => {
  const cli = (over: Record<string, unknown> = {}) => ({ env: () => ({}), bin: async () => '/usr/local/bin/claude', signedIn: async () => true as const, ...over });

  it('parses claude -p json output into text and usage, summing cache tokens into input', () => {
    const out = JSON.stringify({ type: 'result', result: 'Be specific.', usage: { input_tokens: 100, cache_read_input_tokens: 400, cache_creation_input_tokens: 20, output_tokens: 7 }, duration_ms: 1234, model: 'claude-haiku-5-5' });
    expect(parseClaudeJson(`{"type":"system"}\n${out}`, 9)).toEqual({ text: 'Be specific.', usage: { inputTokens: 520, outputTokens: 7 }, ms: 1234, model: 'claude-haiku-5-5' });
    expect(parseClaudeJson('garbage', 1)).toBeNull();
    expect(parseClaudeJson(JSON.stringify({ result: 'x', is_error: true }), 1)).toBeNull();
  });

  it('transcriptOf passes a lone user message through and labels a longer exchange', () => {
    expect(transcriptOf([{ role: 'user', content: 'hi' }])).toBe('hi');
    expect(transcriptOf([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }])).toBe('User: a\n\nAssistant: b');
  });

  it('runs claude with the system prompt and json output; falls back to OpenRouter when the CLI is not signed in', async () => {
    const calls: { bin: string; args: string[]; stdin: string }[] = [];
    const run = async (bin: string, args: string[], o: { stdin: string }) => { calls.push({ bin, args, stdin: o.stdin }); return { code: 0, stdout: JSON.stringify({ result: 'ok', usage: { input_tokens: 1, output_tokens: 2 } }) }; };
    const r = createAssistRunner({ cli: cli(), run });
    expect(await r.available()).toBe(true);
    const out = await r.run({ system: 'Judge.', messages: [{ role: 'user', content: 'Fix it' }], maxTokens: 100 });
    expect(out).toMatchObject({ text: 'ok', usage: { inputTokens: 1, outputTokens: 2 } });
    expect(calls[0].args).toEqual(expect.arrayContaining(['--system-prompt', 'Judge.', '--output-format', 'json', '--max-turns', '1']));
    expect(calls[0].stdin).toBe('Fix it');

    const fetched: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => { fetched.push(JSON.parse(String(init.body))); return { ok: true, json: async () => ({ choices: [{ message: { content: 'via router' } }], usage: { prompt_tokens: 5, completion_tokens: 6 }, model: 'm' }) }; }) as unknown as typeof fetch;
    const r2 = createAssistRunner({ cli: cli({ signedIn: async () => false as const }), getApiKey: async () => 'sk', fetchImpl });
    expect(await r2.available()).toBe(true);
    expect(await r2.run({ messages: [{ role: 'user', content: 'x' }], maxTokens: 50 })).toEqual({ text: 'via router', usage: { inputTokens: 5, outputTokens: 6 }, ms: expect.any(Number), model: 'm' });
    expect((fetched[0] as { max_tokens: number }).max_tokens).toBe(50);

    const r3 = createAssistRunner({ cli: cli({ signedIn: async () => false as const }) });
    expect(await r3.available()).toBe(false);
    expect(await r3.run({ messages: [{ role: 'user', content: 'x' }], maxTokens: 50 })).toBeNull();
  });
});
