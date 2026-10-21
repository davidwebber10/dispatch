import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createTelemetrySettingsRouter } from '../../src/routes/telemetry-settings.js';

describe('telemetry settings route', () => {
  it('GET is on by default; PUT false turns it off; a bad body is 400', async () => {
    const db = new Database(':memory:'); initSchema(db);
    const app = express(); app.use(express.json()); app.use('/api/settings/telemetry', createTelemetrySettingsRouter(db));
    expect((await request(app).get('/api/settings/telemetry')).body).toEqual({ enabled: true });
    expect((await request(app).put('/api/settings/telemetry').send({ enabled: false })).body).toEqual({ enabled: false });
    expect((await request(app).get('/api/settings/telemetry')).body).toEqual({ enabled: false });
    expect((await request(app).put('/api/settings/telemetry').send({ enabled: 'no' })).status).toBe(400);
  });
});
