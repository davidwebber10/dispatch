import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { createUsageLimitSettingsRouter } from './usage-limit-settings.js';

let db: Database.Database;
let changes: number;
const app = () => {
  const a = express();
  a.use(express.json());
  a.use('/api/settings/usage-limits', createUsageLimitSettingsRouter(db, { onChange: () => { changes++; } }));
  return a;
};
beforeEach(() => { db = new Database(':memory:'); initSchema(db); changes = 0; });

describe('/api/settings/usage-limits', () => {
  it('GET returns the defaults', async () => {
    const r = await request(app()).get('/api/settings/usage-limits');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ warnPercent: 80, pushOnWarn: true });
  });

  it('PUT stores, returns the stored values and applies them once', async () => {
    const r = await request(app()).put('/api/settings/usage-limits').send({ warnPercent: 85.4 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ warnPercent: 85, pushOnWarn: true });
    expect(changes).toBe(1);
    const r2 = await request(app()).put('/api/settings/usage-limits').send({ pushOnWarn: false });
    expect(r2.body).toEqual({ warnPercent: 85, pushOnWarn: false });
    expect(changes).toBe(2);
    expect((await request(app()).get('/api/settings/usage-limits')).body).toEqual({ warnPercent: 85, pushOnWarn: false });
  });

  it('clamps an out-of-range threshold', async () => {
    expect((await request(app()).put('/api/settings/usage-limits').send({ warnPercent: 30 })).body.warnPercent).toBe(50);
    expect((await request(app()).put('/api/settings/usage-limits').send({ warnPercent: 120 })).body.warnPercent).toBe(99);
  });

  it('400s a bad value and changes nothing', async () => {
    for (const body of [{ warnPercent: '85' }, { warnPercent: null }, { pushOnWarn: 'yes' }, {}, { other: 1 }]) {
      const r = await request(app()).put('/api/settings/usage-limits').send(body);
      expect(r.status).toBe(400);
    }
    expect(changes).toBe(0);
    expect((await request(app()).get('/api/settings/usage-limits')).body).toEqual({ warnPercent: 80, pushOnWarn: true });
  });
});
