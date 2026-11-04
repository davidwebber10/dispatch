import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db/schema.js';
import { createWatchesRouter } from '../src/routes/watches.js';

let db: Database.Database;
function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/watches', createWatchesRouter(db));
  return a;
}
afterEach(() => { delete process.env.DISPATCH_MAX_WATCHES; });
beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  db.prepare("INSERT INTO sessions (id, provider, name, working_dir, created_at, updated_at, last_activity_at) VALUES ('s','claude-code','p','/tmp','now','now','now')").run();
});

function terminals(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `t${i}`;
    db.prepare("INSERT INTO terminals (id, session_id, type, label, created_at) VALUES (?, 's', 'claude-code', ?, 'now')").run(id, id);
    ids.push(id);
  }
  return ids;
}

describe('total watch cap (SEC-23)', () => {
  it('refuses a watch past DISPATCH_MAX_WATCHES with a clear 429', async () => {
    process.env.DISPATCH_MAX_WATCHES = '2';
    const [a, b, c, d] = terminals(4);
    const ok1 = await request(app()).post('/api/watches').send({ watcherTerminalId: a, targetTerminalId: d, criteria: 'idle' });
    const ok2 = await request(app()).post('/api/watches').send({ watcherTerminalId: b, targetTerminalId: d, criteria: 'idle' });
    expect([ok1.status, ok2.status]).toEqual([201, 201]);
    const over = await request(app()).post('/api/watches').send({ watcherTerminalId: c, targetTerminalId: d, criteria: 'idle' });
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/2 live watches/);
    expect(over.body.error).toMatch(/DISPATCH_MAX_WATCHES/);
  });

  it('frees a slot when a watch is removed', async () => {
    process.env.DISPATCH_MAX_WATCHES = '1';
    const [a, b, c] = terminals(3);
    const first = await request(app()).post('/api/watches').send({ watcherTerminalId: a, targetTerminalId: c, criteria: 'idle' });
    expect((await request(app()).post('/api/watches').send({ watcherTerminalId: b, targetTerminalId: c, criteria: 'idle' })).status).toBe(429);
    await request(app()).delete(`/api/watches/${first.body.id}`).query({ watcher: a });
    expect((await request(app()).post('/api/watches').send({ watcherTerminalId: b, targetTerminalId: c, criteria: 'idle' })).status).toBe(201);
  });

  it('0 turns the cap off, and the default is generous', async () => {
    process.env.DISPATCH_MAX_WATCHES = '0';
    const ids = terminals(8);
    for (let i = 0; i < 7; i++) {
      expect((await request(app()).post('/api/watches').send({ watcherTerminalId: ids[i], targetTerminalId: ids[7], criteria: 'idle' })).status).toBe(201);
    }
    delete process.env.DISPATCH_MAX_WATCHES;
    const { maxWatchesTotal } = await import('../src/caps.js');
    expect(maxWatchesTotal()).toBe(500);
  });
});
