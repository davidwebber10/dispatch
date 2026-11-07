import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { PluginHooks } from '../../src/plugins/hooks.js';
import { ThreadEvents } from '../../src/plugins/thread-events.js';
import { KeyRegistry } from '../../src/auth/principals.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hook scripts (docs/superpowers/specs/2026-11-07-plugins-design.md, section 3.3): a script per event, the payload on stdin. */
describe('PluginHooks (2026-11-07)', () => {
  let tmp: string; let dir: string; let keys: KeyRegistry; let reg: PluginRegistry; let te: ThreadEvents; let hooks: PluginHooks | null;
  const outFile = (id: string) => path.join(tmp, `${id}.out`);
  // A script that appends its stdin (and a few env names) to a file; `sleep` makes it hang.
  const script = (id: string, body = '') => `
    const fs = require('fs');
    let data = '';
    process.stdin.on('data', (c) => data += c);
    process.stdin.on('end', () => {
      fs.appendFileSync(${JSON.stringify(outFile(id))}, JSON.stringify({ event: JSON.parse(data), plugin: process.env.DISPATCH_PLUGIN, hasKeyFile: !!process.env.DISPATCH_PLUGIN_AUTH_FILE, terminal: process.env.DISPATCH_TERMINAL }) + '\\n');
      ${body}
    });
  `;
  const plugin = (id: string, permissions: string[], hooksSpec: Record<string, unknown>, body = '') => {
    fs.mkdirSync(path.join(dir, id, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'plugin.json'), JSON.stringify({ id, name: id, version: '1', permissions, model: { hooks: hooksSpec } }));
    for (const f of new Set(Object.values(hooksSpec).map((h) => (h as { run: string }).run))) fs.writeFileSync(path.join(dir, id, f), script(id, body));
  };
  const lines = (id: string) => (fs.existsSync(outFile(id)) ? fs.readFileSync(outFile(id), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hooks-'));
    dir = path.join(tmp, 'plugins');
    keys = new KeyRegistry();
    hooks = null;
    te = new ThreadEvents({ broadcast: () => {} }, (id) => (id === 't1' ? { sessionId: 's1', harness: 'claude-code' } : null));
  });
  afterEach(async () => { hooks?.stop(); await sleep(20); fs.rmSync(tmp, { recursive: true, force: true }); });
  const start = (opts: { timeoutMs?: number; backlog?: number } = {}) => {
    reg = new PluginRegistry(dir, { broadcast: () => {} }, '3.28.0', { keys, keyDir: path.join(tmp, 'keys') });
    reg.issueKeys();
    hooks = new PluginHooks(reg, te, { api: 'http://127.0.0.1:1', ...opts });
    return hooks;
  };

  it('a prompt event runs the prompt hook with the full text when the plugin has read:prompts, with the plugin identity in the env', async () => {
    plugin('logger', ['read:prompts'], { prompt: { run: 'hooks/on-prompt.js' } });
    const h = start();
    te.onPrompt('t1', 'Fix the login bug', 'user');
    await h.idle();
    const out = lines('logger');
    expect(out).toHaveLength(1);
    expect(out[0].event).toMatchObject({ type: 'thread:prompt', terminalId: 't1', text: 'Fix the login bug', textLength: 17 });
    expect(out[0]).toMatchObject({ plugin: 'logger', hasKeyFile: true, terminal: 't1' });
    expect(h.stats('logger')).toEqual({ runs: 1, failures: 0, dropped: 0 });
    reg.setHookStatsProvider((id) => h.stats(id));
    expect(reg.get('logger')!.hooks).toEqual({ runs: 1, failures: 0, dropped: 0 });
  });

  it('a hook without read:prompts gets lengths only', async () => {
    plugin('blind', [], { prompt: { run: 'hooks/p.js' }, toolCall: { run: 'hooks/t.js' } });
    const h = start();
    te.onPrompt('t1', 'secret text', 'user');
    te.onTool('t1', 'Bash', { command: 'rm -rf /' });
    await h.idle();
    const out = lines('blind');
    expect(out).toHaveLength(2);
    expect(out[0].event).toEqual(expect.objectContaining({ type: 'thread:prompt', textLength: 11 }));
    expect(out[0].event.text).toBeUndefined();
    expect(out[1].event.input).toBeUndefined();
    expect(out[1].event.inputLength).toBeGreaterThan(0);
  });

  it('toolCall hooks filter by tool name glob; other events only reach their own hook', async () => {
    plugin('bashy', ['read:prompts'], { toolCall: { run: 'hooks/t.js', tools: ['Bash', 'mcp__dispatch__*'] } });
    const h = start();
    te.onTool('t1', 'Read', { path: 'x' });
    te.onTool('t1', 'Bash', { command: 'ls' });
    te.onTool('t1', 'mcp__dispatch__preview', {});
    te.onPrompt('t1', 'hello', 'user');
    te.onStatus('t1', { state: 'done', summary: 's' });
    await h.idle();
    expect(lines('bashy').map((l) => l.event.tool)).toEqual(['Bash', 'mcp__dispatch__preview']);
  });

  it('a hanging script is killed at the timeout and the queue continues; the failure is counted', async () => {
    plugin('slow', [], { status: { run: 'hooks/s.js' } }, 'if (JSON.parse(data).summary === "hang") setTimeout(() => {}, 60000);');
    const h = start({ timeoutMs: 300 });
    te.onStatus('t1', { state: 'done', summary: 'hang' });
    te.onStatus('t1', { state: 'done', summary: 'after' });
    await h.idle();
    const out = lines('slow');
    expect(out.map((l) => l.event.summary)).toEqual(['hang', 'after']);
    expect(h.stats('slow')).toMatchObject({ runs: 2, failures: 1 });
  }, 10000);

  it('the backlog cap drops the oldest events and counts them; a disabled plugin runs nothing', async () => {
    plugin('busy', [], { status: { run: 'hooks/s.js' } }, 'const t = Date.now(); while (Date.now() - t < 150) {}');
    plugin('off', [], { status: { run: 'hooks/s.js' } });
    const h = start({ backlog: 2 });
    reg.setEnabled('off', false);
    for (let i = 0; i < 5; i++) te.onStatus('t1', { state: 'done', summary: `n${i}` });
    await h.idle();
    const got = lines('busy').map((l) => l.event.summary);
    expect(got.length).toBeLessThanOrEqual(3);
    expect(got[got.length - 1]).toBe('n4');
    expect(h.stats('busy').dropped).toBeGreaterThanOrEqual(2);
    expect(lines('off')).toEqual([]);
  }, 15000);
});
