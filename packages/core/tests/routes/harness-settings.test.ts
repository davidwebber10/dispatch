import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createHarnessSettingsRouter } from '../../src/routes/harness-settings.js';
import { readHarnessSettings, updateHarnessSettings, opencodeKeySecretName, OPENCODE_DEFAULT_KEY_SECRET } from '../../src/settings/harness-settings.js';

function makeApp(secretValue: string | null = null, onChanged?: () => void) {
  const db = new Database(':memory:');
  initSchema(db);
  const secrets = { getSecret: async () => secretValue };
  const app = express();
  app.use(express.json());
  app.use('/api/settings/harnesses', createHarnessSettingsRouter(db, secrets, onChanged));
  return { app, db };
}

describe('harness settings store', () => {
  it('merges field-wise per harness; null clears; unknown harnesses and fields are dropped', () => {
    const db = new Database(':memory:');
    initSchema(db);
    updateHarnessSettings(db, { opencode: { defaultModel: 'openrouter/moonshotai/kimi-k3', keySecret: 'MY_OR_KEY' } });
    updateHarnessSettings(db, { 'claude-code': { defaultMode: 'pretty' }, bogus: { defaultModel: 'x' } });
    updateHarnessSettings(db, { opencode: { defaultModel: null, junkField: 'y' } });
    expect(readHarnessSettings(db)).toEqual({
      opencode: { keySecret: 'MY_OR_KEY' },
      'claude-code': { defaultMode: 'pretty' },
    });
    expect(opencodeKeySecretName(db)).toBe('MY_OR_KEY');
  });

  it('defaults the opencode key secret name when never configured', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(opencodeKeySecretName(db)).toBe(OPENCODE_DEFAULT_KEY_SECRET);
  });
});

describe('/api/settings/harnesses', () => {
  it('GET reports settings plus whether the opencode key secret RESOLVES (never its value)', async () => {
    const { app } = makeApp('sk-or-real-key');
    const res = await request(app).get('/api/settings/harnesses');
    expect(res.status).toBe(200);
    expect(res.body.opencodeKey).toEqual({ secret: OPENCODE_DEFAULT_KEY_SECRET, present: true });
    expect(JSON.stringify(res.body)).not.toContain('sk-or-real-key');
  });

  it('PUT merges, fires onChanged (the env refresh hook), and reflects a renamed secret', async () => {
    let changed = 0;
    const { app } = makeApp(null, () => { changed++; });
    const res = await request(app).put('/api/settings/harnesses').send({ opencode: { keySecret: 'OTHER_KEY' } });
    expect(res.status).toBe(200);
    expect(changed).toBe(1);
    expect(res.body.settings.opencode.keySecret).toBe('OTHER_KEY');
    expect(res.body.opencodeKey).toEqual({ secret: 'OTHER_KEY', present: false });
  });

  it('a Doppler failure reads as key-absent, not a 500', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const app = express();
    app.use(express.json());
    app.use('/api/settings/harnesses', createHarnessSettingsRouter(db, { getSecret: async () => { throw new Error('Doppler is not connected'); } }));
    const res = await request(app).get('/api/settings/harnesses');
    expect(res.status).toBe(200);
    expect(res.body.opencodeKey.present).toBe(false);
  });
});
