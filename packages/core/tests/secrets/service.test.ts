import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SecretsService } from '../../src/secrets/service.js';

function fakeClient(verify = true) {
  return {
    verify: vi.fn(async () => verify),
    listProjects: vi.fn(async () => [{ id: 'p1', slug: 'dispatch', name: 'Dispatch' }]),
    listConfigs: vi.fn(async () => [{ name: 'dev', environment: 'dev' }]),
    listSecrets: vi.fn(async () => [{ name: 'API_KEY', value: 'xyz' }]),
    getSecret: vi.fn(async () => 'xyz'),
    setSecret: vi.fn(async () => {}),
    deleteSecret: vi.fn(async () => {}),
  } as any;
}

let dir: string;
let mcpPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-secrets-'));
  mcpPath = path.join(dir, 'mcp-dist.js');
  fs.writeFileSync(mcpPath, '// fake doppler-mcp dist'); // so active() sees the entry exists
  delete process.env.DOPPLER_TOKEN;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const svc = (verify = true) => new SecretsService(dir, () => fakeClient(verify), mcpPath);

describe('SecretsService', () => {
  it('starts disconnected with no injection', () => {
    const s = svc();
    expect(s.status()).toEqual({ connected: false, project: null, config: null, enabled: true, readOnly: false, tokenScope: 'all' });
    expect(s.getBaseSpawnEnv()).toEqual({});
    expect(s.getInjection()).toEqual({ claudeConfigPath: null, codexArgs: [], systemPrompt: null, codexThreadConfig: {} });
  });

  it('provides a Doppler system-prompt instruction (with project/config) when connected', async () => {
    const s = svc(true);
    await s.setConnection({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' });
    const sp = s.getInjection().systemPrompt!;
    expect(sp).toMatch(/Doppler/);
    expect(sp).toContain('dispatch');
    expect(sp).toContain('dev');
  });

  it('keeps values out of the transcript: names-only list, doppler run first, get reveals only when asked', async () => {
    const s = svc(true);
    await s.setConnection({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' });
    const sp = s.getInjection().systemPrompt!;
    expect(sp).toMatch(/doppler_list_secrets lists[^.]*names only/);
    expect(sp).toContain('prefer `doppler run --project dispatch --config dev -- <command>`');
    expect(sp).toMatch(/doppler_get_secret checks whether a secret exists[^.]*reveal: true[^.]*only when the user asks to see the value/);
    expect(sp).not.toMatch(/only when you need the value itself/);
  });

  // `doppler run -- curl -H "Bearer $API_KEY"` expands in the outer shell (empty), and the
  // `sh -c '…$API_KEY…'` retry puts the value in the child's argv, which the owner's EDR logs.
  it('warns that the command must read the secret from its env, never from its arguments', async () => {
    const s = svc(true);
    await s.setConnection({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' });
    const sp = s.getInjection().systemPrompt!;
    expect(sp).toContain('The command must read the secret from its own environment');
    expect(sp).toContain('never expand `$NAME` into a command argument or inside `sh -c`');
    expect(sp).toContain("every process's arguments are visible on this machine");
  });

  it('has no system prompt when disconnected', () => {
    expect(svc().getInjection().systemPrompt).toBeNull();
  });

  it('notes read-only mode in the system prompt, and drops the store instruction', async () => {
    const s = svc(true);
    await s.setConnection({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' });
    expect(s.getInjection().systemPrompt).toContain('Store new secrets with doppler_set_secret');
    await s.setConnection({ token: '', readOnly: true });
    const sp = s.getInjection().systemPrompt!;
    expect(sp).toMatch(/read-only|do not (create|modify)/i);
    expect(sp).not.toContain('doppler_set_secret');
  });

  it('verifies + stores a token (0600) but stays disconnected until project+config', async () => {
    const s = svc(true);
    await s.setConnection({ token: 'dp.sa.x' });
    expect(s.status().connected).toBe(false);
    expect((s.status() as unknown as Record<string, unknown>).token).toBeUndefined();
    expect((fs.statSync(path.join(dir, 'doppler.json')).mode & 0o777)).toBe(0o600);
  });

  it('rejects an invalid token', async () => {
    await expect(svc(false).setConnection({ token: 'bad' })).rejects.toThrow(/invalid/i);
  });

  it('preserves the token when a later update sends an empty token, then connects', async () => {
    const s = svc(true);
    await s.setConnection({ token: 'dp.sa.x' });
    await s.setConnection({ token: '', project: 'dispatch', config: 'dev' });
    expect(s.status()).toMatchObject({ connected: true, project: 'dispatch', config: 'dev' });
    // W1-C: a new connection is opted-in, so the token is in the thread env only, not in the base env.
    expect(s.getBaseSpawnEnv()).toEqual({ DOPPLER_PROJECT: 'dispatch', DOPPLER_CONFIG: 'dev', DOPPLER_READ_ONLY: '0' });
    expect(s.getThreadTokenEnv({ secretsEnv: true })).toEqual({ DOPPLER_TOKEN: 'dp.sa.x' });
  });

  it('generates a claude mcp config (no token, --secrets-dir) + codex -c args when connected', async () => {
    const s = svc(true);
    await s.setConnection({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' });
    const inj = s.getInjection();
    expect(inj.claudeConfigPath).toBe(path.join(dir, 'doppler.mcp.json'));
    const cfg = JSON.parse(fs.readFileSync(inj.claudeConfigPath!, 'utf8'));
    expect(cfg.mcpServers.doppler.command).toBe('node');
    // W1-C: the server reads the saved connection from --secrets-dir; the file names no token.
    expect(cfg.mcpServers.doppler.args).toEqual([mcpPath, '--secrets-dir', dir]);
    expect(cfg.mcpServers.doppler.env).toBeUndefined();
    expect(inj.codexArgs.join(' ')).toContain('mcp_servers.doppler');
  });

  it('readOnly toggle preserves the token, sets DOPPLER_READ_ONLY=1, and blocks writes', async () => {
    const s = svc(true);
    await s.setConnection({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' });
    await s.setConnection({ token: '', readOnly: true });
    expect(s.getBaseSpawnEnv().DOPPLER_READ_ONLY).toBe('1');
    await expect(s.setSecret('A', 'b')).rejects.toThrow(/read-only/i);
    await expect(s.deleteSecret('A')).rejects.toThrow(/read-only/i);
  });

  it('proxies list/set/delete through the client when connected', async () => {
    const client = fakeClient(true);
    const s = new SecretsService(dir, () => client, mcpPath);
    await s.setConnection({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' });
    expect(await s.listSecrets()).toEqual([{ name: 'API_KEY' }]);
    await s.setSecret('A', 'b');
    expect(client.setSecret).toHaveBeenCalledWith('dispatch', 'dev', 'A', 'b');
    await s.deleteSecret('A');
    expect(client.deleteSecret).toHaveBeenCalledWith('dispatch', 'dev', 'A');
  });

  it('disconnect clears the connection + files', async () => {
    const s = svc(true);
    await s.setConnection({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' });
    s.disconnect();
    expect(s.status().connected).toBe(false);
    expect(fs.existsSync(path.join(dir, 'doppler.json'))).toBe(false);
  });
});

// W1-C (engineering program v4.5.0): the token scope. An install made before the scope existed
// keeps the token in every thread's environment; a new connection gives it only to threads the
// owner turns on.
describe('SecretsService token scope', () => {
  /** A connection file as an earlier version wrote it: no tokenScope field. */
  const seedLegacy = (extra: Record<string, unknown> = {}) => fs.writeFileSync(
    path.join(dir, 'doppler.json'),
    JSON.stringify({ token: 'dp.sa.old', project: 'dispatch', config: 'dev', enabled: true, readOnly: false, ...extra }),
    { mode: 0o600 },
  );

  it('a saved connection with no tokenScope reads as all and getBaseSpawnEnv carries the token', () => {
    seedLegacy();
    const s = svc();
    expect(s.status().tokenScope).toBe('all');
    expect(s.getBaseSpawnEnv()).toEqual({ DOPPLER_TOKEN: 'dp.sa.old', DOPPLER_PROJECT: 'dispatch', DOPPLER_CONFIG: 'dev', DOPPLER_READ_ONLY: '0' });
    expect(s.getThreadTokenEnv({ secretsEnv: true })).toEqual({});
  });

  it('a later settings change keeps the scope of a saved connection that had no field', async () => {
    seedLegacy();
    const s = svc();
    await s.setConnection({ token: '', readOnly: true });
    expect(s.status().tokenScope).toBe('all');
    expect(s.getBaseSpawnEnv().DOPPLER_TOKEN).toBe('dp.sa.old');
  });

  it('a new connection is saved as opted-in', async () => {
    const s = svc();
    await s.setConnection({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' });
    expect(s.status().tokenScope).toBe('opted-in');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'doppler.json'), 'utf8')).tokenScope).toBe('opted-in');
  });

  it('with opted-in, getBaseSpawnEnv has no DOPPLER_TOKEN', async () => {
    const s = svc();
    await s.setConnection({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' });
    expect(s.getBaseSpawnEnv()).toEqual({ DOPPLER_PROJECT: 'dispatch', DOPPLER_CONFIG: 'dev', DOPPLER_READ_ONLY: '0' });
  });

  it('getThreadTokenEnv gives the token only for secretsEnv true and scope opted-in', async () => {
    const s = svc();
    await s.setConnection({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' });
    expect(s.getThreadTokenEnv({ secretsEnv: true })).toEqual({ DOPPLER_TOKEN: 'dp.sa.x' });
    expect(s.getThreadTokenEnv({ secretsEnv: false })).toEqual({});
    expect(s.getThreadTokenEnv({})).toEqual({});
    expect(s.getThreadTokenEnv({ secretsEnv: 'true' as unknown as boolean })).toEqual({});
    s.setTokenScope('all');
    expect(s.getThreadTokenEnv({ secretsEnv: true })).toEqual({});
    expect(s.getBaseSpawnEnv().DOPPLER_TOKEN).toBe('dp.sa.x');
  });

  it('getThreadTokenEnv gives nothing while Doppler is disabled or not connected', async () => {
    const s = svc();
    expect(s.getThreadTokenEnv({ secretsEnv: true })).toEqual({});
    await s.setConnection({ token: 'dp.sa.x', project: 'dispatch', config: 'dev', enabled: false });
    expect(s.getThreadTokenEnv({ secretsEnv: true })).toEqual({});
  });

  it('setTokenScope saves the scope, tells the listener and refuses an unknown value', () => {
    seedLegacy();
    const s = svc();
    const changed = vi.fn();
    s.onChange(changed);
    expect(s.setTokenScope('opted-in').tokenScope).toBe('opted-in');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(svc().status().tokenScope).toBe('opted-in');
    expect(() => s.setTokenScope('everything' as never)).toThrow(/invalid/i);
    expect((fs.statSync(path.join(dir, 'doppler.json')).mode & 0o777)).toBe(0o600);
  });

  it('setConnection takes a tokenScope and refuses an unknown one', async () => {
    seedLegacy();
    const s = svc();
    expect((await s.setConnection({ tokenScope: 'opted-in' })).tokenScope).toBe('opted-in');
    expect(s.getBaseSpawnEnv().DOPPLER_TOKEN).toBeUndefined();
    await expect(s.setConnection({ tokenScope: 'nope' as never })).rejects.toThrow(/invalid/i);
  });

  it('the Claude and Codex MCP configs hold no ${DOPPLER_TOKEN} reference and pass --secrets-dir', async () => {
    for (const scope of ['all', 'opted-in'] as const) {
      seedLegacy({ tokenScope: scope });
      const s = svc();
      const inj = s.getInjection();
      const claudeText = fs.readFileSync(inj.claudeConfigPath!, 'utf8');
      expect(claudeText).not.toContain('DOPPLER_TOKEN');
      expect(JSON.parse(claudeText).mcpServers.doppler.args).toEqual([mcpPath, '--secrets-dir', dir]);
      const codex = inj.codexArgs.join(' ');
      expect(codex).not.toContain('DOPPLER_TOKEN');
      expect(codex).toContain('--secrets-dir');
      expect(codex).toContain(dir);
      expect(s.getServerSpec()!.args).toEqual([mcpPath, '--secrets-dir', dir]);
      // The file from ensureClaudeMcpConfig is the same one.
      expect(fs.readFileSync(s.ensureClaudeMcpConfig()!, 'utf8')).not.toContain('DOPPLER_TOKEN');
    }
  });

  it('a token that only the daemon environment holds still reaches the MCP server by reference', () => {
    // No token in the file: the server cannot read it from --secrets-dir, so the old shape stays.
    fs.writeFileSync(path.join(dir, 'doppler.json'), JSON.stringify({ project: 'dispatch', config: 'dev' }));
    process.env.DOPPLER_TOKEN = 'dp.sa.env';
    try {
      const s = svc();
      expect(s.status().tokenScope).toBe('all');
      expect(s.getBaseSpawnEnv().DOPPLER_TOKEN).toBe('dp.sa.env');
      expect(s.getServerSpec()!.envVars).toContain('DOPPLER_TOKEN');
    } finally { delete process.env.DOPPLER_TOKEN; }
  });

  it('the system prompt does not claim that the token is set', async () => {
    for (const scope of ['all', 'opted-in'] as const) {
      seedLegacy({ tokenScope: scope });
      const sp = svc().getSystemPrompt()!;
      expect(sp).not.toMatch(/DOPPLER_TOKEN is already set/);
      expect(sp).toMatch(/Use the "doppler" MCP tools/);
      expect(sp).toMatch(/If `\$DOPPLER_TOKEN` is set in the shell, prefer\s+`doppler run --project dispatch --config dev -- <command>`/);
    }
  });
});
