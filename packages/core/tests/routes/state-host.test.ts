import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createApp } from '../../src/server.js';
import { initSchema } from '../../src/db/schema.js';

describe('GET /api/state/host', () => {
  let app: any;

  beforeEach(() => {
    const db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
  });

  it('reports the platform and the reveal capability', async () => {
    const res = await request(app).get('/api/state/host');
    expect(res.status).toBe(200);
    expect(res.body.platform).toBe(process.platform);
    // supertest connects over loopback, so on macOS this is true.
    expect(res.body.canReveal).toBe(process.platform === 'darwin');
  });

  it('is not fooled by a forged X-Forwarded-For', async () => {
    // A remote client cannot LOSE the capability by lying either — the point is that the
    // header is ignored entirely and only the real socket address counts.
    const res = await request(app).get('/api/state/host').set('X-Forwarded-For', '8.8.8.8');
    expect(res.body.canReveal).toBe(process.platform === 'darwin');
  });
});
