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
    expect(s.status()).toEqual({ connected: false, project: null, config: null, enabled: true, readOnly: false });
    expect(s.getSpawnEnv()).toEqual({});
    expect(s.getInjection()).toEqual({ claudeConfigPath: null, codexArgs: [] });
  });

  it('verifies + stores a token (0600) but stays disconnected until project+config', async () => {
    const s = svc(true);
    await s.setConnection({ token: 'dp.sa.x' });
    expect(s.status().connected).toBe(false);
    expect((s.status() as Record<string, unknown>).token).toBeUndefined();
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
    expect(s.getSpawnEnv()).toMatchObject({ DOPPLER_TOKEN: 'dp.sa.x', DOPPLER_PROJECT: 'dispatch', DOPPLER_CONFIG: 'dev', DOPPLER_READ_ONLY: '0' });
  });

  it('generates a claude mcp config (token by reference) + codex -c args when connected', async () => {
    const s = svc(true);
    await s.setConnection({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' });
    const inj = s.getInjection();
    expect(inj.claudeConfigPath).toBe(path.join(dir, 'doppler.mcp.json'));
    const cfg = JSON.parse(fs.readFileSync(inj.claudeConfigPath!, 'utf8'));
    expect(cfg.mcpServers.doppler.command).toBe('node');
    expect(cfg.mcpServers.doppler.args).toEqual([mcpPath]);
    expect(cfg.mcpServers.doppler.env.DOPPLER_TOKEN).toBe('${DOPPLER_TOKEN}'); // by reference, never literal
    expect(inj.codexArgs.join(' ')).toContain('mcp_servers.doppler');
  });

  it('readOnly toggle preserves the token, sets DOPPLER_READ_ONLY=1, and blocks writes', async () => {
    const s = svc(true);
    await s.setConnection({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' });
    await s.setConnection({ token: '', readOnly: true });
    expect(s.getSpawnEnv().DOPPLER_READ_ONLY).toBe('1');
    await expect(s.setSecret('A', 'b')).rejects.toThrow(/read-only/i);
    await expect(s.deleteSecret('A')).rejects.toThrow(/read-only/i);
  });

  it('proxies list/set/delete through the client when connected', async () => {
    const client = fakeClient(true);
    const s = new SecretsService(dir, () => client, mcpPath);
    await s.setConnection({ token: 'dp.sa.x', project: 'dispatch', config: 'dev' });
    expect(await s.listSecrets()).toEqual([{ name: 'API_KEY', value: 'xyz' }]);
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
