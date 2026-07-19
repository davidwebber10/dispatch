import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as watchesDb from '../../src/db/watches.js';
import { createApp } from '../../src/server.js';
import { MAX_LIVE_WATCHES_PER_WATCHER } from '../../src/overseer/guards.js';

describe('watch routes', () => {
  let app: any;
  let db: Database.Database;
  let sessionA: string;
  let sessionB: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });

    const resA = await request(app).post('/api/sessions').send({ provider: 'claude-code', workingDir: '/tmp/proj-a', name: 'project a' });
    sessionA = resA.body.id;
    const resB = await request(app).post('/api/sessions').send({ provider: 'claude-code', workingDir: '/tmp/proj-b', name: 'project b' });
    sessionB = resB.body.id;

    terminalsDb.create(db, { id: 'watcher-1', sessionId: sessionA, type: 'claude-code', label: 'watcher' });
    terminalsDb.create(db, { id: 'target-1', sessionId: sessionA, type: 'claude-code', label: 'target' });
    terminalsDb.create(db, { id: 'other-project-1', sessionId: sessionB, type: 'claude-code', label: 'foreign' });
  });

  describe('POST /api/watches', () => {
    it('creates a watch and returns 201 with an id', async () => {
      const res = await request(app).post('/api/watches').send({
        watcherTerminalId: 'watcher-1',
        targetTerminalId: 'target-1',
        criteria: 'idle',
        note: 'ping me',
      });
      expect(res.status).toBe(201);
      expect(typeof res.body.id).toBe('string');
      expect(res.body.id.length).toBeGreaterThan(0);

      const row = watchesDb.listByWatcher(db, 'watcher-1')[0];
      expect(row.id).toBe(res.body.id);
      expect(row.target_terminal_id).toBe('target-1');
      expect(row.criteria).toBe('idle');
      expect(row.note).toBe('ping me');
    });

    it('rejects cross-project watches with 400 "not in this project"', async () => {
      const res = await request(app).post('/api/watches').send({
        watcherTerminalId: 'watcher-1',
        targetTerminalId: 'other-project-1',
        criteria: 'idle',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('not in this project');
    });

    it('returns 404 when the watcher terminal is unknown', async () => {
      const res = await request(app).post('/api/watches').send({
        watcherTerminalId: 'nope',
        targetTerminalId: 'target-1',
        criteria: 'idle',
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 when the target terminal is unknown', async () => {
      const res = await request(app).post('/api/watches').send({
        watcherTerminalId: 'watcher-1',
        targetTerminalId: 'nope',
        criteria: 'idle',
      });
      expect(res.status).toBe(404);
    });

    it('returns 400 for an invalid criteria value', async () => {
      const res = await request(app).post('/api/watches').send({
        watcherTerminalId: 'watcher-1',
        targetTerminalId: 'target-1',
        criteria: 'bogus',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
    });

    it(`refuses with 429 once the watcher already has ${MAX_LIVE_WATCHES_PER_WATCHER} live watches`, async () => {
      for (let i = 0; i < MAX_LIVE_WATCHES_PER_WATCHER; i++) {
        terminalsDb.create(db, { id: `target-cap-${i}`, sessionId: sessionA, type: 'claude-code', label: `target ${i}` });
        const r = await request(app).post('/api/watches').send({
          watcherTerminalId: 'watcher-1',
          targetTerminalId: `target-cap-${i}`,
          criteria: 'idle',
        });
        expect(r.status).toBe(201);
      }

      terminalsDb.create(db, { id: 'target-cap-over', sessionId: sessionA, type: 'claude-code', label: 'over' });
      const over = await request(app).post('/api/watches').send({
        watcherTerminalId: 'watcher-1',
        targetTerminalId: 'target-cap-over',
        criteria: 'idle',
      });
      expect(over.status).toBe(429);
      expect(over.body.error).toBeTruthy();
    });
  });

  describe('GET /api/watches', () => {
    it('lists watches by watcher under "watching"', async () => {
      await request(app).post('/api/watches').send({ watcherTerminalId: 'watcher-1', targetTerminalId: 'target-1', criteria: 'idle' });

      const res = await request(app).get('/api/watches?watcher=watcher-1');
      expect(res.status).toBe(200);
      expect(res.body.watching).toHaveLength(1);
      expect(res.body.watching[0].watcher_terminal_id).toBe('watcher-1');
      expect(res.body.watchedBy).toEqual([]);
    });

    it('lists watches by target under "watchedBy"', async () => {
      await request(app).post('/api/watches').send({ watcherTerminalId: 'watcher-1', targetTerminalId: 'target-1', criteria: 'idle' });

      const res = await request(app).get('/api/watches?target=target-1');
      expect(res.status).toBe(200);
      expect(res.body.watchedBy).toHaveLength(1);
      expect(res.body.watchedBy[0].target_terminal_id).toBe('target-1');
      expect(res.body.watching).toEqual([]);
    });
  });

  describe('DELETE /api/watches/:id', () => {
    it('deletes an existing watch', async () => {
      const create = await request(app).post('/api/watches').send({ watcherTerminalId: 'watcher-1', targetTerminalId: 'target-1', criteria: 'idle' });
      const id = create.body.id;

      const res = await request(app).delete(`/api/watches/${id}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(watchesDb.listByWatcher(db, 'watcher-1')).toHaveLength(0);
    });

    it('returns 404 for a missing id', async () => {
      const res = await request(app).delete('/api/watches/does-not-exist');
      expect(res.status).toBe(404);
    });
  });
});
