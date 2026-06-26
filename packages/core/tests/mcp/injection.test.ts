import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { composeInjection } from '../../src/mcp/injection.js';

describe('composeInjection', () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inj-')), 'mcp.json');

  it('returns nulls/[] when there are no specs', () => {
    const r = composeInjection([], { configPath, prompts: [] });
    expect(r).toEqual({ claudeConfigPath: null, codexArgs: [], systemPrompt: null });
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
});
