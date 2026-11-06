import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { createDictationSettingsRouter, createCoordinatorSettingsRouter } from './shared-settings.js';
import { policyKindOf } from '../auth/route-policy.js';
import * as appState from '../db/app-state.js';

function app() {
  const db = new Database(':memory:');
  initSchema(db);
  const a = express();
  a.use(express.json());
  a.use('/api/settings/dictation', createDictationSettingsRouter(db));
  a.use('/api/settings/coordinator', createCoordinatorSettingsRouter(db));
  return { a, db };
}

describe('GET/PUT /api/settings/dictation', () => {
  it('reports saved: false before anything is stored', async () => {
    const res = await request(app().a).get('/api/settings/dictation');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saved: false });
  });

  it('stores provider, model and secret name under stt_settings, and reads them back', async () => {
    const { a, db } = app();
    const put = await request(a).put('/api/settings/dictation').send({ provider: 'elevenlabs', model: 'scribe_v2', secretName: 'ELEVEN_KEY' });
    expect(put.body).toEqual({ provider: 'elevenlabs', model: 'scribe_v2', secretName: 'ELEVEN_KEY', saved: true });
    expect(JSON.parse(appState.get(db, 'stt_settings')!)).toEqual({ provider: 'elevenlabs', model: 'scribe_v2', secretName: 'ELEVEN_KEY' });
    const get = await request(a).get('/api/settings/dictation');
    expect(get.body).toEqual({ provider: 'elevenlabs', model: 'scribe_v2', secretName: 'ELEVEN_KEY', saved: true });
  });

  it('merges field-wise: an absent field is kept, null clears one, junk is dropped', async () => {
    const { a } = app();
    await request(a).put('/api/settings/dictation').send({ provider: 'groq', model: 'whisper-large-v3', secretName: 'GROQ_API_KEY' });
    await request(a).put('/api/settings/dictation').send({ model: 'whisper-large-v3-turbo' });
    let res = await request(a).get('/api/settings/dictation');
    expect(res.body).toMatchObject({ provider: 'groq', model: 'whisper-large-v3-turbo', secretName: 'GROQ_API_KEY' });
    await request(a).put('/api/settings/dictation').send({ secretName: null, provider: 'has spaces', bogus: 1 });
    res = await request(a).get('/api/settings/dictation');
    expect(res.body).toEqual({ provider: 'groq', model: 'whisper-large-v3-turbo', saved: true });
  });

  it('accepts an empty secret name (none chosen) but refuses a malformed one', async () => {
    const { a } = app();
    expect((await request(a).put('/api/settings/dictation').send({ secretName: '' })).body.secretName).toBe('');
    expect((await request(a).put('/api/settings/dictation').send({ secretName: 'rm -rf' })).body.secretName).toBe('');
  });
});

describe('GET/PUT /api/settings/coordinator', () => {
  it('reports saved: false before anything is stored, then the stored name', async () => {
    const { a, db } = app();
    expect((await request(a).get('/api/settings/coordinator')).body).toEqual({ saved: false });
    const put = await request(a).put('/api/settings/coordinator').send({ name: 'Mission Control ' });
    // Kept as typed: the field saves on every keystroke, so a trailing space mid-word must survive.
    expect(put.body).toEqual({ name: 'Mission Control ', saved: true });
    expect(JSON.parse(appState.get(db, 'coordinator_settings')!)).toEqual({ name: 'Mission Control ' });
  });

  it('caps the length and strips control characters', async () => {
    const { a } = app();
    const res = await request(a).put('/api/settings/coordinator').send({ name: `a\u0007b${'x'.repeat(100)}` });
    expect(res.body.name).toBe(`ab${'x'.repeat(58)}`);
  });
});

describe('policy', () => {
  it('both routers are owner only (no key may read or write them)', () => {
    for (const r of [createDictationSettingsRouter, createCoordinatorSettingsRouter]) {
      const router = r(new Database(':memory:')) as unknown as { stack: { route?: { stack: { handle: unknown }[] } }[] };
      const routes = router.stack.filter((l) => l.route);
      expect(routes.length).toBe(2);
      for (const l of routes) expect(policyKindOf(l.route!.stack[0].handle)).toBe('owner');
    }
  });
});
