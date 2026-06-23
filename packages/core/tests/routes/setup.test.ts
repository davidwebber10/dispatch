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
