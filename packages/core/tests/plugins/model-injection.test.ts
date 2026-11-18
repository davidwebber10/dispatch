import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { KeyRegistry } from '../../src/auth/principals.js';
import { setProfileSource, fallbackProfile } from '../../src/os/profile.js';

/** The model part of a plugin (docs/superpowers/specs/2026-11-07-plugins-design.md, sections 3.1 and 3.2). */
describe('PluginRegistry.modelInjection (2026-11-07)', () => {
  let tmp: string; let dir: string; let keys: KeyRegistry;
  const reg = () => new PluginRegistry(dir, { broadcast: () => {} }, '3.28.0', { keys, keyDir: path.join(tmp, 'keys') });
  const plugin = (id: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) => {
    fs.mkdirSync(path.join(dir, id, 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'plugin.json'), JSON.stringify({ id, name: `Plugin ${id}`, version: '1.0.0', ...manifest }));
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, id, f), body);
  };
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-model-')); dir = path.join(tmp, 'plugins'); keys = new KeyRegistry(); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("lists an enabled plugin's mcp spec with the plugin env, and its instructions as a prompt block under its name", () => {
    plugin('coach', { model: { instructions: 'instructions.md', mcp: { command: 'node', args: ['mcp/server.js'], env: { LOG: '1' } } } },
      { 'instructions.md': 'Run the tests before you report done.\n', 'mcp/server.js': '' });
    const r = reg(); r.issueKeys();
    const inj = r.modelInjection('claude-code');
    // A relative arg that names a file in the plugin folder becomes absolute: the server runs from any cwd.
    expect(inj.specs).toEqual([{
      name: 'plugin-coach', command: 'node', args: [path.join(fs.realpathSync(path.join(dir, 'coach')), 'mcp/server.js')], authEnv: true,
      env: { LOG: '1', DISPATCH_PLUGIN: 'coach', DISPATCH_PLUGIN_AUTH_FILE: path.join(tmp, 'keys', 'plugin-coach') },
    }]);
    expect(inj.prompts).toEqual(['## Plugin: Plugin coach\n\nRun the tests before you report done.']);
    expect(inj.toolNames).toEqual(['plugin-coach']);
  });

  it('a plugin scoped to other harnesses is skipped; one with neither instructions nor mcp adds nothing', () => {
    plugin('codex-only', { model: { instructions: 'i.md', harnesses: ['codex'] } }, { 'i.md': 'x' });
    plugin('plain', {});
    const r = reg(); r.issueKeys();
    expect(r.modelInjection('claude-code')).toEqual({ specs: [], prompts: [], toolNames: [] });
    expect(r.modelInjection('codex').prompts).toEqual(['## Plugin: Plugin codex-only\n\nx']);
  });

  it('injection skips a plugin without a key (disabled) and a broken one', () => {
    plugin('off', { model: { instructions: 'i.md' } }, { 'i.md': 'x' });
    plugin('broken', { id: 'other', model: { instructions: 'i.md' } }, { 'i.md': 'x' });
    const r = reg(); r.issueKeys();
    r.setEnabled('off', false);
    expect(r.modelInjection('claude-code')).toEqual({ specs: [], prompts: [], toolNames: [] });
  });

  it('instructions join in id order; a missing instructions file is skipped with the row marked', () => {
    plugin('b-two', { model: { instructions: 'i.md' } }, { 'i.md': 'two' });
    plugin('a-one', { model: { instructions: 'i.md' } }, { 'i.md': 'one' });
    plugin('c-gone', { model: { instructions: 'missing.md' } });
    const r = reg(); r.issueKeys();
    expect(r.modelInjection('claude-code').prompts).toEqual(['## Plugin: Plugin a-one\n\none', '## Plugin: Plugin b-two\n\ntwo']);
    expect(r.get('c-gone')?.error).toMatch(/instructions/);
  });

  it('a model block whose files leave the folder makes the plugin broken', () => {
    plugin('bad', { model: { instructions: '../secret.md' } });
    expect(reg().get('bad')?.error).toMatch(/instructions/);
    plugin('bad2', { model: { mcp: { command: 'node', args: ['../../x.js'] } } });
    expect(reg().get('bad2')?.error).toBeUndefined(); // args are the server's business; only the manifest's own files are confined
  });

  it('a business person on a hosted box: DISPATCH_HOSTED and DISPATCH_BUSINESS, and no not-business block', () => {
    plugin('inbox', { model: { instructions: 'i.md', mcp: { command: 'node', args: ['mcp/server.js'] } } },
      { 'i.md': 'Use the Inbox.\n\n<!-- not-business -->\nSend a secret.\n<!-- /not-business -->\n', 'mcp/server.js': '' });
    const r = reg(); r.issueKeys();
    const saved = { base: process.env.OS_BASE_URL, token: process.env.OS_BOX_TOKEN };
    try {
      expect(r.modelInjection('claude-code').prompts).toEqual(['## Plugin: Plugin inbox\n\nUse the Inbox.\n\nSend a secret.']);
      process.env.OS_BASE_URL = 'http://platform.invalid'; process.env.OS_BOX_TOKEN = 'proof-token';
      setProfileSource(() => 'business');
      const biz = r.modelInjection('claude-code');
      expect(biz.specs[0].env).toMatchObject({ DISPATCH_HOSTED: '1', DISPATCH_BUSINESS: '1' });
      expect(biz.prompts).toEqual(['## Plugin: Plugin inbox\n\nUse the Inbox.']);
      setProfileSource(() => 'developer');
      const dev = r.modelInjection('claude-code');
      expect(dev.specs[0].env?.DISPATCH_HOSTED).toBe('1');
      expect(dev.specs[0].env?.DISPATCH_BUSINESS).toBeUndefined();
      expect(dev.prompts[0]).toContain('Send a secret.');
    } finally {
      setProfileSource(() => fallbackProfile(process.env));
      if (saved.base === undefined) delete process.env.OS_BASE_URL; else process.env.OS_BASE_URL = saved.base;
      if (saved.token === undefined) delete process.env.OS_BOX_TOKEN; else process.env.OS_BOX_TOKEN = saved.token;
    }
  });
});
