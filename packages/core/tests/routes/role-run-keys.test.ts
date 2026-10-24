import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as watchesDb from '../../src/db/watches.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { configurePairLimiter } from '../../src/auth/key-rules.js';
import { KeysManager } from './keys-manager.js';

describe('role-run keys', () => {
  let app: any;
  let db: Database.Database;
  let tmp: string;
  const as = (id: string) => ({ Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId: id }).key}` });
  const mk = (id: string, sessionId: string, config: Record<string, any> = {}) =>
    terminalsDb.create(db, { id, sessionId, type: 'claude-code', label: id, config: { transport: 'structured', ...config } });

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    configurePairLimiter();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-rr-'));
    db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true, managers: new Map([['claude-code', new KeysManager().asManager()]]) });
    for (const id of ['A', 'B']) {
      const dir = path.join(tmp, id);
      fs.mkdirSync(dir);
      sessionsDb.create(db, { id, provider: 'claude-code', name: `proj-${id}`, workingDir: dir });
    }
    mk('coordA', 'A', { role: 'coordinator', spawnDepth: 0 });
    mk('wA', 'A', { role: 'agent', spawnedBy: 'coordA', spawnDepth: 1 });
    mk('rr', 'A', { role: 'agent', roleRun: 'nightly', spawnDepth: 0 });
    mk('rrCoord', 'A', { role: 'coordinator', roleRun: 'nightly', spawnDepth: 0 });
    mk('coordB', 'B', { role: 'coordinator', spawnDepth: 0 });
    mk('wB', 'B', { role: 'agent', spawnedBy: 'coordB', spawnDepth: 1 });
    terminalsDb.updateSortOrder(db, 'coordA', 1);
    terminalsDb.updateSortOrder(db, 'rrCoord', 5);
    terminalsDb.updateSortOrder(db, 'coordB', 1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is refused on create, message, start, archive, answer and the project list', async () => {
    const key = as('rr');
    const calls = [
      request(app).post('/api/sessions/A/terminals').set(key).send({ type: 'claude-code' }),
      request(app).post('/api/terminals/wA/message').set(key).send({ text: 'x' }),
      request(app).post('/api/terminals/wA/start').set(key),
      request(app).delete('/api/terminals/wA').set(key),
      request(app).post('/api/terminals/wA/permission').set(key).send({ decision: 'allow' }),
      request(app).get('/api/sessions').set(key),
    ];
    for (const call of calls) {
      const res = await call;
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('owner_only');
    }
  });

  it('is refused on the ledger and on a plain route', async () => {
    const key = as('rr');
    for (const call of [
      request(app).post('/api/sessions/A/ledger/list').set(key).send({}),
      request(app).post('/api/terminals/rr/stop').set(key),
    ]) expect((await call).body.error).toBe('owner_only');
  });

  it('reads, reports and watches inside its own project', async () => {
    const key = as('rr');
    for (const url of ['/api/sessions/A/terminals', '/api/terminals/wA', '/api/terminals/wA/conversation', '/api/terminals/wA/permission']) {
      await request(app).get(url).set(key).expect(200);
    }
    vi.spyOn(app._sessionService, 'reportStatus').mockReturnValue(true);
    await request(app).post('/api/terminals/rr/report-status').set(key).send({ state: 'done', summary: 's' }).expect(204);
    await request(app).post('/api/events/claude/rr').set(key).send({}).expect(204);
    const created = await request(app).post('/api/watches').set(key).send({ targetTerminalId: 'wA', criteria: 'idle' }).expect(201);
    const listed = await request(app).get('/api/watches').set(key).expect(200);
    expect(listed.body.watching).toHaveLength(1);
    await request(app).delete(`/api/watches/${created.body.id}`).set(key).expect(200);
    expect(watchesDb.listByWatcher(db, 'rr')).toHaveLength(0);
    const auth = await request(app).post('/api/auth-requests').set(key).send({ url: 'https://example.com/x' }).expect(201);
    expect(auth.body.terminalId).toBe('rr');
  });

  it('redacts a key inside the pending permission answer (input and questions)', async () => {
    const leak = `dtk_${'Q'.repeat(43)}`;
    vi.spyOn(app._sessionService, 'getPendingPermission').mockReturnValue({
      requestId: 'r1', toolName: 'Bash', input: { command: `echo ${leak}`, nested: [leak] }, questions: [{ question: `use ${leak}?`, options: [{ label: leak }] }],
    });
    const r = await request(app).get('/api/terminals/wA/permission').set(as('rr')).expect(200);
    expect(JSON.stringify(r.body)).not.toContain(leak);
    expect(r.body.input.command).toBe('echo dtk_[redacted]');
    expect(r.body.questions[0].question).toBe('use dtk_[redacted]?');
  });

  it('redacts a live key used as a property name in the pending permission input', async () => {
    const live = as('wA').Authorization.replace('Bearer ', '');
    vi.spyOn(app._sessionService, 'getPendingPermission').mockReturnValue({
      requestId: 'r2', toolName: 'Bash', input: { mapping: { [live]: 'value' }, list: [{ [live]: 1 }] },
    });
    const r = await request(app).get('/api/terminals/wA/permission').set(as('rr')).expect(200);
    expect(JSON.stringify(r.body)).not.toContain(live);
    expect(Object.values(r.body.input.mapping)).toEqual(['value']);
  });

  it('keeps the same identity rules as a thread key', async () => {
    const key = as('rr');
    expect((await request(app).post('/api/terminals/wA/report-status').set(key).send({ state: 'done', summary: 's' })).body.error).toBe('out_of_scope');
    expect((await request(app).post('/api/watches').set(key).send({ watcherTerminalId: 'wA', targetTerminalId: 'wA', criteria: 'idle' })).body.error).toBe('identity_mismatch');
    expect((await request(app).post('/api/watches').set(key).send({ targetTerminalId: 'wB', criteria: 'idle' })).body.error).toBe('out_of_scope');
    expect((await request(app).post('/api/events/claude/wA').set(key).send({})).body.error).toBe('out_of_scope');
    expect((await request(app).post('/api/auth-requests').set(key).send({ url: 'https://example.com/x', terminalId: 'wA' })).body.error).toBe('identity_mismatch');
  });

  it('is never an overseer, even with config.role coordinator', async () => {
    for (const who of ['rr', 'rrCoord']) {
      const key = as(who);
      for (const url of ['/api/sessions/B/terminals', '/api/terminals/wB', '/api/terminals/wB/conversation', '/api/terminals/coordB/permission']) {
        const res = await request(app).get(url).set(key);
        expect(res.status, `${who} ${url}`).toBe(403);
        expect(res.body.error).toBe('out_of_scope');
      }
    }
  });

  it('a normal thread key still reads its project (the rules are separate)', async () => {
    await request(app).get('/api/sessions/A/terminals').set(as('wA')).expect(200);
  });
});
