import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

// Detection hits the real filesystem/PATH otherwise — stub it for deterministic shapes.
vi.mock('../../src/setup/detect.js', () => ({
  detectAllProviders: async () => ([{ name: 'claude', installed: true, signedIn: true }, { name: 'codex', installed: false, signedIn: false }]),
  detectTailscale: async () => ({ installed: false, running: false }),
  setProviderProbeEnv: () => {}, // W3-A: the test build runs the spawn-env refresh of the daemon, which sets it
}));

describe('setup routes', () => {
  let app: any; let db: any;
  beforeEach(() => {
    db = new Database(':memory:'); initSchema(db);
    // Isolate the secrets dir so the test machine's real Doppler connection
    // doesn't leak in (status would otherwise read ~/.dispatch/doppler.json).
    const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-setup-test-'));
    app = createApp({ db, skipPty: true, secretsDir });
  });

  it('reports firstRun true before completion', async () => {
    const res = await request(app).get('/api/setup/state');
    expect(res.status).toBe(200);
    expect(res.body.firstRun).toBe(true);
    expect(res.body.providers).toHaveLength(2);
    expect(res.body.secrets).toEqual({ connected: false });
  });

  // Review of #189: for the app, "Claude is signed in" is the account a new thread runs on (the
  // default Claude account). The machine's own login answers only when that account is the CLI login.
  it('the Claude provider is signed in when the default account is, also when the machine login is not', async () => {
    const { setClaudeSignedInSource } = await import('../../src/auth/claude-login-sources.js');
    try {
      setClaudeSignedInSource(async () => false);
      expect((await request(app).get('/api/setup/providers')).body.find((p: any) => p.name === 'claude').signedIn).toBe(false);
      expect((await request(app).get('/api/setup/state')).body.providers.find((p: any) => p.name === 'claude').signedIn).toBe(false);
      setClaudeSignedInSource(async () => true);
      expect((await request(app).get('/api/setup/providers')).body.find((p: any) => p.name === 'claude').signedIn).toBe(true);
      // Review round 2: a check that could not answer is 'unknown'. It never borrows the answer of
      // another login (the machine's), in either direction.
      setClaudeSignedInSource(async () => 'unknown');
      expect((await request(app).get('/api/setup/providers')).body.find((p: any) => p.name === 'claude').signedIn).toBe('unknown');
      setClaudeSignedInSource(async () => { throw new Error('probe failed'); });
      expect((await request(app).get('/api/setup/providers')).body.find((p: any) => p.name === 'claude').signedIn).toBe('unknown');
      // The machine's own answer travels apart, for a thread that the person puts on the CLI login.
      setClaudeSignedInSource(async () => false);
      expect((await request(app).get('/api/setup/providers')).body.find((p: any) => p.name === 'claude')).toMatchObject({ signedIn: false, machineSignedIn: true });
      // Codex is not touched.
      expect((await request(app).get('/api/setup/providers')).body.find((p: any) => p.name === 'codex')).toEqual({ name: 'codex', installed: false, signedIn: false });
    } finally { setClaudeSignedInSource(null); }
  });

  it('POST /complete flips firstRun to false', async () => {
    await request(app).post('/api/setup/complete').expect(200);
    const res = await request(app).get('/api/setup/state');
    expect(res.body.firstRun).toBe(false);
  });

  it('GET /providers returns the provider array', async () => {
    const res = await request(app).get('/api/setup/providers');
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('claude');
  });
});
