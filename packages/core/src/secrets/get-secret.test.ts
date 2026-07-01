import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SecretsService } from './service.js';

function fakeClient() {
  return {
    verify: async () => true,
    listProjects: async () => [],
    listConfigs: async () => [],
    listSecrets: async () => [],
    getSecret: async (_p: string, _c: string, name: string) => (name === 'GROQ_API_KEY' ? 'gsk_live_123' : null),
    setSecret: async () => {},
    deleteSecret: async () => {},
  } as any;
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-sec-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('SecretsService.getSecret', () => {
  it('resolves a secret value by name via the stored connection', async () => {
    const svc = new SecretsService(dir, () => fakeClient());
    await svc.setConnection({ token: 't', project: 'dispatch', config: 'prd', enabled: true, readOnly: true });
    expect(await svc.getSecret('GROQ_API_KEY')).toBe('gsk_live_123');
    expect(await svc.getSecret('MISSING')).toBeNull();
  });

  it('throws when Doppler is not connected', async () => {
    const svc = new SecretsService(dir, () => fakeClient());
    await expect(svc.getSecret('GROQ_API_KEY')).rejects.toThrow(/not connected/i);
  });
});
