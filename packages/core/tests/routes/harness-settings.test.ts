import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createHarnessSettingsRouter } from '../../src/routes/harness-settings.js';
import { readHarnessSettings, updateHarnessSettings, opencodeKeySecretName, OPENCODE_DEFAULT_KEY_SECRET } from '../../src/settings/harness-settings.js';
import { OPENCODE_DEFAULT_MODELS } from '../../src/providers/opencode.js';
import { resetCatalogCache } from '../../src/settings/openrouter-catalog.js';

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

describe('/api/settings/harnesses — opencode model list', () => {
  it('GET serves the curated defaults as opencodeModels until the user sets a list', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/settings/harnesses');
    expect(res.body.opencodeModels).toEqual(OPENCODE_DEFAULT_MODELS);
    expect(res.body.settings.opencode?.models).toBeUndefined();
  });

  it('PUT replaces the list whole; null restores the defaults', async () => {
    const { app } = makeApp();
    const mine = [{ label: 'Kimi', model: 'openrouter/~moonshotai/kimi-latest' }];
    let res = await request(app).put('/api/settings/harnesses').send({ opencode: { models: mine } });
    expect(res.body.opencodeModels).toEqual(mine);
    expect(res.body.settings.opencode.models).toEqual(mine);
    res = await request(app).put('/api/settings/harnesses').send({ opencode: { models: null } });
    expect(res.body.opencodeModels).toEqual(OPENCODE_DEFAULT_MODELS);
  });
});

describe('/api/settings/harnesses/opencode/catalog', () => {
  const catalog = {
    data: [
      { id: '~x-ai/grok-latest', name: 'xAI: Grok Latest', context_length: 500000, created: 2, alias_target: { slug: 'x-ai/grok-4.6' } },
      { id: 'x-ai/grok-4.6', name: 'xAI: Grok 4.6', context_length: 500000, created: 3 },
      { id: 'qwen/qwen3.8-max-0902', name: 'Qwen: Qwen3.8 Max (0902)', context_length: 1000000, created: 4 },
    ],
  };
  const withCatalog = (fetchImpl: typeof fetch) => {
    const db = new Database(':memory:');
    initSchema(db);
    const app = express();
    app.use(express.json());
    app.use('/api/settings/harnesses', createHarnessSettingsRouter(db, undefined, undefined, { fetchImpl }));
    return app;
  };

  beforeEach(() => resetCatalogCache());

  it('searches the live catalog and returns OpenCode-ready ids, aliases first', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => catalog })) as unknown as typeof fetch;
    const res = await request(withCatalog(fetchImpl)).get('/api/settings/harnesses/opencode/catalog?q=grok');
    expect(res.status).toBe(200);
    expect(res.body.map((e: { id: string }) => e.id)).toEqual(['openrouter/~x-ai/grok-latest', 'openrouter/x-ai/grok-4.6']);
    expect(res.body[0]).toMatchObject({ label: 'Grok Latest', alias: true, aliasTarget: 'x-ai/grok-4.6' });
  });

  it('reports an unreachable catalog as 502 with a message, not as an empty list', async () => {
    const fetchImpl = (async () => { throw new Error('getaddrinfo ENOTFOUND openrouter.ai'); }) as unknown as typeof fetch;
    const res = await request(withCatalog(fetchImpl)).get('/api/settings/harnesses/opencode/catalog?q=grok');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/OpenRouter catalog/);
  });
});
