import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { composeInjection } from '../../src/mcp/injection.js';

describe('composeInjection', () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inj-')), 'mcp.json');

  it('folds developerNote into systemPrompt and codex developer_instructions', () => {
    const r = composeInjection([], { configPath: '/tmp/mcp.json', prompts: [], developerNote: 'use jq' });
    expect(r.systemPrompt).toBe('use jq');
    const i = r.codexArgs.indexOf('developer_instructions=' + JSON.stringify('use jq'));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(r.codexArgs[i - 1]).toBe('-c');
  });

  it('joins prompts and developerNote for the system prompt', () => {
    const r = composeInjection([], { configPath: '/x', prompts: ['mcp hint'], developerNote: 'tools note' });
    expect(r.systemPrompt).toBe('mcp hint\n\ntools note');
  });

  it('no developerNote → no developer_instructions arg', () => {
    const r = composeInjection([], { configPath: '/x', prompts: [] });
    expect(r.systemPrompt).toBeNull();
    expect(r.codexArgs.some((a) => a.startsWith('developer_instructions='))).toBe(false);
  });

  it('still emits mcp config + args when specs exist', () => {
    const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inj-')), 'mcp.json');
    const r = composeInjection([{ name: 'srv', command: 'node', args: ['x.js'] }], { configPath: cfg, prompts: [], developerNote: 'n' });
    expect(r.claudeConfigPath).toBe(cfg);
    expect(r.codexArgs.some((a) => a.startsWith('mcp_servers.srv.command='))).toBe(true);
    expect(r.codexArgs.some((a) => a.startsWith('developer_instructions='))).toBe(true);
  });

  it('returns nulls/[] when there are no specs', () => {
    const r = composeInjection([], { configPath, prompts: [] });
    expect(r).toEqual({ claudeConfigPath: null, codexArgs: [], systemPrompt: null, codexThreadConfig: {} });
  });

  it('merges multiple servers into one Claude config + Codex args', () => {
    const r = composeInjection([
      { name: 'doppler', command: 'node', args: ['/x/doppler.js'], env: { DOPPLER_TOKEN: '${DOPPLER_TOKEN}' }, envVars: ['DOPPLER_TOKEN'] },
      { name: 'executor', command: 'executor', args: ['mcp'] },
    ], { configPath, prompts: ['use doppler', 'use executor'] });

    const cfg = JSON.parse(fs.readFileSync(r.claudeConfigPath!, 'utf-8'));
    expect(Object.keys(cfg.mcpServers)).toEqual(['doppler', 'executor']);
    expect(cfg.mcpServers.executor).toEqual({ command: 'executor', args: ['mcp'] });
    expect(r.codexArgs).toContain('mcp_servers.executor.command="executor"');
    expect(r.codexArgs).toContain('mcp_servers.doppler.env_vars=["DOPPLER_TOKEN"]');
    // env+envVars (placeholder pattern) must NOT also emit a literal Codex env override.
    expect(r.codexArgs).not.toContain('mcp_servers.doppler.env.DOPPLER_TOKEN="${DOPPLER_TOKEN}"');
    expect(r.systemPrompt).toBe('use doppler\n\nuse executor');
  });

  it('emits Codex literal env via dotted path for a spec with env and no envVars', () => {
    const r = composeInjection([
      { name: 'fs', command: 'npx', args: ['-y', 'server-fs'], env: { ROOT: '/tmp' } },
    ], { configPath, prompts: [] });
    expect(r.codexArgs).toContain('mcp_servers.fs.env.ROOT="/tmp"');
    const cfg = JSON.parse(fs.readFileSync(r.claudeConfigPath!, 'utf-8'));
    expect(cfg.mcpServers.fs.env).toEqual({ ROOT: '/tmp' });
  });

  // M3: the Codex app-server is shared, so per-thread MCP identity cannot ride its argv. Each spec
  // becomes a per-thread `config` entry for thread/start + thread/resume, keyed by a DOTTED path so
  // it merges with (never replaces) the user's own config.toml mcp_servers — live-verified on
  // codex-cli 0.156.1, same env / env_vars rules as the -c args.
  it('codexThreadConfig carries every MCP server as a dotted per-thread config entry', () => {
    const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inj-')), 'mcp.json');
    const r = composeInjection([
      { name: 'dispatch', command: 'node', args: ['a.js'], env: { DISPATCH_TERMINAL: 't1', DISPATCH_SPAWN_DEPTH: '1' } },
      { name: 'doppler', command: 'node', args: ['d.js'], envVars: ['DOPPLER_TOKEN'], env: { IGNORED: 'x' } },
    ], { configPath: cfg, prompts: [] });
    expect(r.codexThreadConfig).toEqual({
      'mcp_servers.dispatch': { command: 'node', args: ['a.js'], env: { DISPATCH_TERMINAL: 't1', DISPATCH_SPAWN_DEPTH: '1' } },
      'mcp_servers.doppler': { command: 'node', args: ['d.js'], env_vars: ['DOPPLER_TOKEN'] },
    });
  });
  // Per-thread keys (13b): a spec with authEnv receives the key through the environment. The key
  // is never a literal in a file or in argv.
  describe('authEnv', () => {
    const KEY = 'dtk_' + 'A'.repeat(43);
    const agency = { name: 'dispatch', command: 'node', args: ['a.js'], env: { DISPATCH_TERMINAL: 't1', DISPATCH_API: 'http://127.0.0.1:1' }, authEnv: true };
    const mk = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inj-')), 'mcp.json');

    it('writes a reference, never the key, into the Claude-style file', () => {
      const r = composeInjection([agency], { configPath: mk(), prompts: [] });
      const cfg = JSON.parse(fs.readFileSync(r.claudeConfigPath!, 'utf-8'));
      expect(cfg.mcpServers.dispatch.env).toEqual({ DISPATCH_TERMINAL: 't1', DISPATCH_API: 'http://127.0.0.1:1', DISPATCH_AUTH: '${DISPATCH_AUTH}' });
      expect(JSON.stringify(cfg)).not.toMatch(/dtk_/);
    });

    it('Codex CLI args: literal non-secret env plus env_vars for the key variable, no key', () => {
      const r = composeInjection([agency], { configPath: mk(), prompts: [], authVar: 'DISPATCH_AUTH_FILE' });
      expect(r.codexArgs).toContain('mcp_servers.dispatch.env_vars=["DISPATCH_AUTH_FILE"]');
      expect(r.codexArgs).toContain('mcp_servers.dispatch.env.DISPATCH_TERMINAL="t1"');
      expect(r.codexArgs).toContain('mcp_servers.dispatch.env.DISPATCH_API="http://127.0.0.1:1"');
      expect(r.codexArgs.join(' ')).not.toMatch(/d[tcs]k_/);
      const cfg = JSON.parse(fs.readFileSync(r.claudeConfigPath!, 'utf-8'));
      expect(cfg.mcpServers.dispatch.env.DISPATCH_AUTH_FILE).toBe('${DISPATCH_AUTH_FILE}');
    });

    it('the Codex thread config carries the literal only when asked, and never env_vars', () => {
      const without = composeInjection([agency], { configPath: mk(), prompts: [] });
      expect(without.codexThreadConfig['mcp_servers.dispatch']).toEqual({
        command: 'node', args: ['a.js'], env: { DISPATCH_TERMINAL: 't1', DISPATCH_API: 'http://127.0.0.1:1' },
      });
      const withKey = composeInjection([agency], { configPath: mk(), prompts: [], codexAuthLiteral: KEY });
      expect(withKey.codexThreadConfig['mcp_servers.dispatch']).toEqual({
        command: 'node', args: ['a.js'], env: { DISPATCH_TERMINAL: 't1', DISPATCH_API: 'http://127.0.0.1:1', DISPATCH_AUTH: KEY },
      });
      expect(withKey.codexArgs.join(' ')).not.toContain(KEY);
      const cfg = fs.readFileSync(withKey.claudeConfigPath!, 'utf-8');
      expect(cfg).not.toContain(KEY);
    });

    it('other specs are untouched by authEnv', () => {
      const r = composeInjection([agency, { name: 'fs', command: 'npx', args: [], env: { ROOT: '/tmp' } }], { configPath: mk(), prompts: [], codexAuthLiteral: KEY });
      const cfg = JSON.parse(fs.readFileSync(r.claudeConfigPath!, 'utf-8'));
      expect(cfg.mcpServers.fs.env).toEqual({ ROOT: '/tmp' });
      expect(r.codexThreadConfig['mcp_servers.fs']).toEqual({ command: 'npx', args: [], env: { ROOT: '/tmp' } });
    });
  });
});
