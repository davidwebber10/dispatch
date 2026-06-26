import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

describe('integrations routes', () => {
  let app: any;
  beforeEach(() => { const db = new Database(':memory:'); initSchema(db); app = createApp({ db, skipPty: true }); });
  it('GET /api/integrations/status returns the installed shape', async () => {
    const res = await request(app).get('/api/integrations/status');
    expect(res.status).toBe(200);
    expect(typeof res.body.installed).toBe('boolean');
  });
});
