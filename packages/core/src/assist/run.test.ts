import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createAssistRunner, parseClaudeJson, transcriptOf, commandAssistRunner, ASSIST_CLAUDE_MODEL, ASSIST_OPENROUTER_MODEL } from './run.js';

describe('assist runner (2026-11-07)', () => {
  const cli = (over: Record<string, unknown> = {}) => ({ env: () => ({}), bin: async () => '/usr/local/bin/claude', signedIn: async () => true as const, ...over });

  it('parses claude -p json output into text and usage, keeping cache tokens apart', () => {
    const out = JSON.stringify({ type: 'result', result: 'Be specific.', usage: { input_tokens: 100, cache_read_input_tokens: 400, cache_creation_input_tokens: 20, output_tokens: 7 }, duration_ms: 1234, model: 'claude-haiku-5-5' });
    expect(parseClaudeJson(`{"type":"system"}\n${out}`, 9)).toEqual({ text: 'Be specific.', usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 400, cacheCreateTokens: 20 }, ms: 1234, model: 'claude-haiku-5-5', harness: 'claude', accountId: null, costUsd: null });
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
    expect(await r2.run({ messages: [{ role: 'user', content: 'x' }], maxTokens: 50 })).toEqual({ text: 'via router', usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheCreateTokens: 0 }, ms: expect.any(Number), model: 'm', harness: 'openrouter', accountId: null, costUsd: null });
    expect((fetched[0] as { max_tokens: number }).max_tokens).toBe(50);

    const r3 = createAssistRunner({ cli: cli({ signedIn: async () => false as const }) });
    expect(await r3.available()).toBe(false);
    expect(await r3.run({ messages: [{ role: 'user', content: 'x' }], maxTokens: 50 })).toBeNull();
  });
});

describe('assist chooses harness and model (coach plan, Task 1)', () => {
  const cli = (over: Record<string, unknown> = {}) => ({ env: () => ({ BASE: '1' }), bin: async (n: string) => `/usr/local/bin/${n}`, signedIn: async () => true as const, ...over });
  const claudeOut = JSON.stringify({ type: 'result', result: 'ok', usage: { input_tokens: 10, cache_read_input_tokens: 300, cache_creation_input_tokens: 40, output_tokens: 5 }, total_cost_usd: 0.0123, model: 'claude-opus-5' });

  it('claude harness passes --model <model> and keeps cache tokens and total_cost_usd', async () => {
    const calls: { bin: string; args: string[]; env: Record<string, string> }[] = [];
    const run = async (bin: string, args: string[], o: { env: Record<string, string> }) => { calls.push({ bin, args, env: o.env }); return { code: 0, stdout: claudeOut }; };
    const r = createAssistRunner({ cli: cli(), run, accountEnv: (h, id): Record<string, string> => (h === 'claude' && id === 'work' ? { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } : {}), defaultAccount: () => 'cli' });
    const out = await r.run({ messages: [{ role: 'user', content: 'x' }], maxTokens: 100, harness: 'claude', model: 'claude-opus-5', accountId: 'work' });
    expect(calls[0].bin).toBe('/usr/local/bin/claude');
    expect(calls[0].args.slice(0, 3)).toEqual(['-p', '--model', 'claude-opus-5']);
    expect(calls[0].env).toMatchObject({ BASE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
    expect(out).toEqual({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 300, cacheCreateTokens: 40 }, ms: expect.any(Number), model: 'claude-opus-5', harness: 'claude', accountId: 'work', costUsd: 0.0123 });
    // No model: the default small Claude model; no account: the harness default.
    expect(await r.run({ messages: [{ role: 'user', content: 'x' }], maxTokens: 100, harness: 'claude' })).toMatchObject({ accountId: 'cli' });
    expect(calls[1].args.slice(0, 3)).toEqual(['-p', '--model', ASSIST_CLAUDE_MODEL]);
  });

  it('codex harness runs codex exec with --model and parses its usage', async () => {
    const calls: { bin: string; args: string[]; stdin: string; env: Record<string, string> }[] = [];
    const run = async (bin: string, args: string[], o: { stdin: string; env: Record<string, string> }) => {
      calls.push({ bin, args, stdin: o.stdin, env: o.env });
      const outFile = args[args.indexOf('-o') + 1];
      fs.writeFileSync(outFile, 'codex answer\n');
      const lines = [
        { type: 'thread.started', thread_id: 't' },
        { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 30 } },
      ];
      return { code: 0, stdout: lines.map((l) => JSON.stringify(l)).join('\n') };
    };
    const r = createAssistRunner({ cli: cli({ codexModel: () => 'gpt-5.6-terra' }), run, accountEnv: (h, id): Record<string, string> => (h === 'codex' && id === 'c2' ? { CODEX_HOME: '/x/c2' } : {}), defaultAccount: (h) => (h === 'codex' ? 'c2' : 'cli') });
    const out = await r.run({ system: 'Judge.', messages: [{ role: 'user', content: 'Fix it' }], maxTokens: 100, harness: 'codex', model: 'gpt-5.6-sol' });
    expect(calls[0].bin).toBe('/usr/local/bin/codex');
    expect(calls[0].args[0]).toBe('exec');
    expect(calls[0].args).toEqual(expect.arrayContaining(['--json', '-m', 'gpt-5.6-sol', '--ephemeral', '--ignore-user-config']));
    expect(calls[0].stdin).toBe('Judge.\n\nFix it');
    expect(calls[0].env).toMatchObject({ CODEX_HOME: '/x/c2' });
    expect(out).toEqual({ text: 'codex answer', usage: { inputTokens: 200, outputTokens: 30, cacheReadTokens: 1000, cacheCreateTokens: 0 }, ms: expect.any(Number), model: 'gpt-5.6-sol', harness: 'codex', accountId: 'c2', costUsd: null });
    // No model: the namer's Codex pick.
    await r.run({ messages: [{ role: 'user', content: 'x' }], maxTokens: 100, harness: 'codex' });
    expect(calls[1].args[calls[1].args.indexOf('-m') + 1]).toBe('gpt-5.6-terra');
  });

  it('openrouter harness sends the given model id', async () => {
    const fetched: { model: string }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => { fetched.push(JSON.parse(String(init.body))); return { ok: true, json: async () => ({ choices: [{ message: { content: 'r' } }], usage: { prompt_tokens: 5, completion_tokens: 6, cost: 0.002 }, model: 'openai/gpt-x' }) }; }) as unknown as typeof fetch;
    const r = createAssistRunner({ cli: cli(), getApiKey: async () => 'sk', fetchImpl, run: async () => { throw new Error('no CLI on an openrouter call'); } });
    const out = await r.run({ messages: [{ role: 'user', content: 'x' }], maxTokens: 50, harness: 'openrouter', model: 'openai/gpt-x' });
    expect(fetched[0].model).toBe('openai/gpt-x');
    expect(out).toMatchObject({ harness: 'openrouter', accountId: null, model: 'openai/gpt-x', costUsd: 0.002 });
    await r.run({ messages: [{ role: 'user', content: 'x' }], maxTokens: 50, harness: 'openrouter' });
    expect(fetched[1].model).toBe(ASSIST_OPENROUTER_MODEL);
  });

  it('an explicit harness that fails returns null, no fallback', async () => {
    let fetched = 0;
    const fetchImpl = (async () => { fetched++; return { ok: true, json: async () => ({ choices: [{ message: { content: 'r' } }] }) }; }) as unknown as typeof fetch;
    const r = createAssistRunner({ cli: cli(), getApiKey: async () => 'sk', fetchImpl, run: async () => ({ code: 1, stdout: '' }) });
    expect(await r.run({ messages: [{ role: 'user', content: 'x' }], maxTokens: 50, harness: 'claude' })).toBeNull();
    expect(await r.run({ messages: [{ role: 'user', content: 'x' }], maxTokens: 50, harness: 'codex' })).toBeNull();
    expect(fetched).toBe(0);
    // A harness that is not signed in is not available for an explicit call.
    const r2 = createAssistRunner({ cli: cli({ signedIn: async () => false as const }), getApiKey: async () => 'sk', fetchImpl });
    expect(await r2.available('claude')).toBe(false);
    expect(await r2.available('openrouter')).toBe(true);
  });

  it('no harness keeps the old order', async () => {
    const order: string[] = [];
    const run = async (bin: string) => { order.push(bin); return { code: 1, stdout: '' }; };
    const fetchImpl = (async () => { order.push('openrouter'); return { ok: true, json: async () => ({ choices: [{ message: { content: 'r' } }] }) }; }) as unknown as typeof fetch;
    const r = createAssistRunner({ cli: cli(), getApiKey: async () => 'sk', fetchImpl, run });
    expect(await r.run({ messages: [{ role: 'user', content: 'x' }], maxTokens: 50 })).toMatchObject({ text: 'r', harness: 'openrouter' });
    expect(order).toEqual(['/usr/local/bin/claude', 'openrouter']);
  });
});

describe('commandAssistRunner (a test seam: DISPATCH_ASSIST_COMMAND)', () => {
  it('spawns the command with the request on stdin and parses its JSON answer', async () => {
    const script = `const chunks=[];process.stdin.on('data',(c)=>chunks.push(c));process.stdin.on('end',()=>{const req=JSON.parse(Buffer.concat(chunks).toString());process.stdout.write(JSON.stringify({text:'echo: '+req.messages[0].content,usage:{inputTokens:3,outputTokens:4},ms:1,model:'cmd'}));});`;
    const r = commandAssistRunner(`${process.execPath} -e ${JSON.stringify(script)}`);
    expect(await r.available()).toBe(true);
    expect(await r.run({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 })).toMatchObject({ text: 'echo: hi', usage: { inputTokens: 3, outputTokens: 4 }, ms: 1, model: 'cmd' });
    const bad = commandAssistRunner(`${process.execPath} -e "process.stdout.write('not json')"`);
    expect(await bad.run({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 })).toBeNull();
  });
});
