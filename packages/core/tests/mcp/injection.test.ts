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
});
