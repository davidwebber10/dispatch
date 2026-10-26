import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { LimitSnapshots } from '../../src/limits/snapshot.js';

describe('GET /api/usage-limits under keys', () => {
  let app: any;
  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    const db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true, usageLimits: { snapshots: new LimitSnapshots(db), accountFor: () => 'acct' } });
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'A', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 'w1', sessionId: 'A', type: 'claude-code', label: 'w1', config: { role: 'agent', spawnDepth: 1 } });
  });

  it('a thread key is refused: the route is owner only', async () => {
    const key = app.locals.keys.mint({ kind: 'thread', terminalId: 'w1' }).key as string;
    const res = await request(app).get('/api/usage-limits?terminalId=w1').set({ Authorization: `Bearer ${key}` });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('owner_only');
  });

  it('the owner (no key) reaches it', async () => {
    const res = await request(app).get('/api/usage-limits?terminalId=w1');
    expect(res.status).toBe(200);
  });
});
