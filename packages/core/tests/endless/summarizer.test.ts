import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeStructuredSessionManager } from '../../src/structured/manager.js';
import { ClaudeSummarizer } from '../../src/endless/summarizer-claude.js';
import { OpenRouterSummarizer } from '../../src/endless/summarizer-openrouter.js';
import { usageOf } from '../../src/endless/summarizer.js';
import { FakeManager } from './fake-manager.js';
import { KeyRegistry } from '../../src/auth/principals.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, '../structured/fake-claude.mjs');
const FAKE_TOOL = path.join(here, 'fake-claude-tool.mjs');

const managers: ClaudeStructuredSessionManager[] = [];
const make = (script: string) => {
  const manager = new ClaudeStructuredSessionManager();
  managers.push(manager);
  return new ClaudeSummarizer({ manager, chatDir: here, mcpConfigPath: '/nowhere.json', command: process.execPath, commandArgs: [script], askTimeoutMs: 10_000 });
};
afterEach(() => { for (const m of managers.splice(0)) m.killAll(); });

describe('ClaudeSummarizer', () => {
  it('answers asks in one conversation and signals the first token', async () => {
    const first = vi.fn();
    const s = make(FAKE).open({ systemPrompt: 'SYS', onFirstToken: first });
    expect(await s.ask('hello')).toBe('echo:hello');
    expect(await s.ask('again')).toBe('echo:again');
    expect(first).toHaveBeenCalledTimes(1);
    s.close();
  });
  it('fails a compaction that calls a tool', async () => {
    const s = make(FAKE_TOOL).open({ systemPrompt: 'SYS', onFirstToken: () => {} });
    await expect(s.ask('summarize')).rejects.toThrow(/called a tool/);
    s.close();
  });
  it('a process that exits between asks fails the next ask at once, not after the timeout', async () => {
    const m = new FakeManager();
    const s = new ClaudeSummarizer({ manager: m.asManager(), chatDir: here, mcpConfigPath: '/nowhere.json', askTimeoutMs: 60_000 })
      .open({ systemPrompt: 'SYS', onFirstToken: () => {} });
    const first = s.ask('one');
    m.emitEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'line' }] } });
    m.emitEvent({ type: 'result', is_error: false });
    expect(await first).toBe('line');
    m.emitExit(1);
    const t0 = Date.now();
    await expect(s.ask('two')).rejects.toThrow(/exited \(1\)/);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(m.sent).toHaveLength(1);
    s.close();
  });
});

describe('ClaudeSummarizer keys', () => {
  it('spawns with a summarizer chat key, revoked on close', () => {
    const keys = new KeyRegistry();
    const m = new FakeManager();
    const s = new ClaudeSummarizer({ manager: m.asManager(), chatDir: here, mcpConfigPath: '/nowhere.json', keys: () => keys })
      .open({ systemPrompt: 'SYS', onFirstToken: () => {} });
    const key = m.spawned[0].opts.env!.DISPATCH_AUTH;
    expect(key).toMatch(/^dck_/);
    expect(keys.resolve(key)).toMatchObject({ kind: 'chat', startedBy: 'summarizer' });
    expect(m.spawned[0].opts.args.join(' ')).not.toContain(key);
    s.close();
    expect(keys.resolve(key)).toBeNull();
  });
  it('revokes when the process exits', () => {
    const keys = new KeyRegistry();
    const m = new FakeManager();
    new ClaudeSummarizer({ manager: m.asManager(), chatDir: here, mcpConfigPath: '/nowhere.json', keys: () => keys })
      .open({ systemPrompt: 'SYS', onFirstToken: () => {} });
    m.emitExit(0);
    expect(keys.size()).toBe(0);
  });
  it('adds no key without a registry', () => {
    const m = new FakeManager();
    new ClaudeSummarizer({ manager: m.asManager(), chatDir: here, mcpConfigPath: '/nowhere.json' }).open({ systemPrompt: 'SYS', onFirstToken: () => {} });
    expect(m.spawned[0].opts.env).not.toHaveProperty('DISPATCH_AUTH');
  });
});

describe('usageOf', () => {
  it('reads Claude usage fields', () => {
    expect(usageOf({ input_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 3, output_tokens: 7 }))
      .toEqual({ input: 5, cacheRead: 90, cacheWrite: 3, output: 7 });
    expect(usageOf(undefined)).toBeNull();
  });
});

describe('OpenRouterSummarizer', () => {
  it('keeps the conversation across asks', async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: `r${bodies.length}` } }] }), { status: 200 });
    });
    const s = new OpenRouterSummarizer({ apiKey: async () => 'k', fetchImpl: fetchImpl as any }).open({ systemPrompt: 'SYS', onFirstToken: () => {} });
    expect(await s.ask('a')).toBe('r1');
    expect(await s.ask('b')).toBe('r2');
    expect(bodies[1].messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });
  it('fails without a key', async () => {
    const s = new OpenRouterSummarizer({ apiKey: async () => null }).open({ systemPrompt: 'SYS', onFirstToken: () => {} });
    await expect(s.ask('a')).rejects.toThrow(/OpenRouter key/);
  });
});
