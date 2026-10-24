import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDatabase } from '../db/connection.js';
import { createUsageLimitsRouter } from './usage-limits.js';
import { LimitSnapshots } from '../limits/snapshot.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as parksDb from '../db/usage-limits.js';

let db: ReturnType<typeof createDatabase>;
let snaps: LimitSnapshots;
const NOW = 1_792_800_000_000;
const term = (id: string, type: string) => {
  if (!sessionsDb.getById(db, 'p')) sessionsDb.create(db, { id: 'p', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  terminalsDb.create(db, { id, sessionId: 'p', type, label: 'T' });
};
const app = () => { const a = express(); a.use('/api', createUsageLimitsRouter(db, snaps, () => NOW)); return a; };

beforeEach(() => {
  db = createDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ul-route-')), 't.db'));
  snaps = new LimitSnapshots(db);
});

describe('GET /api/usage-limits', () => {
  it('404 for an unknown thread', async () => {
    expect((await request(app()).get('/api/usage-limits?terminalId=nope')).status).toBe(404);
  });
  it('a Claude thread gets the shared snapshot; grok and opencode are unsupported', async () => {
    term('c1', 'claude-code'); term('g1', 'grok'); term('o1', 'opencode');
    snaps.record('claude-code', '', { session: { usedPercent: 62, resetsAt: NOW + 1000 } }, NOW);
    const c = (await request(app()).get('/api/usage-limits?terminalId=c1')).body;
    expect(c.supported).toBe(true);
    expect(c.snapshot.session.usedPercent).toBe(62);
    for (const id of ['g1', 'o1']) {
      const b = (await request(app()).get(`/api/usage-limits?terminalId=${id}`)).body;
      expect(b).toMatchObject({ supported: false, snapshot: null });
    }
  });
  it('shows the pause #106 put on the thread, but not a woken one', async () => {
    term('c1', 'claude-code');
    parksDb.upsert(db, { terminal_id: 'c1', provider: 'claude-code', kind: 'session', resets_at: NOW + 5000, wake_at: NOW + 6000, message: 'm', parsed: 1, attempts: 0, state: 'parked', parked_at: NOW }, NOW);
    expect((await request(app()).get('/api/usage-limits?terminalId=c1')).body.paused).toEqual({ kind: 'session', resetsAt: NOW + 5000, capped: false });
    parksDb.setState(db, 'c1', 'woken', 1, NOW, NOW);
    expect((await request(app()).get('/api/usage-limits?terminalId=c1')).body.paused).toBeNull();
  });
});
