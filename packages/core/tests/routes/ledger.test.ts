import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';

describe('ledger routes', () => {
  let app: any;
  let db: Database.Database;
  let sid: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    sid = (await request(app).post('/api/sessions').send({ provider: 'claude-code', workingDir: '/tmp', name: 'ledger' })).body.id;
    terminalsDb.create(db, { id: 'coord', sessionId: sid, type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
    terminalsDb.create(db, { id: 'agent', sessionId: sid, type: 'claude-code', label: 'worker', config: { role: 'agent' } });
  });

  it('POST /ledger creates N1 (201); a non-overseer gets 403 with the fixed text', async () => {
    const ok = await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'coord', kind: 'go', text: 'Merge PR #12.' }).expect(201);
    expect(ok.body.id).toBe('N1');
    expect(ok.body.line).toContain('N1 [Go] Merge PR #12.');
    const denied = await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'agent', kind: 'go', text: 'x' }).expect(403);
    expect(denied.body.error).toBe("Only the project's overseer can change the ledger.");
  });

  it('resolve: 404 unknown, 422 quote not found, 200 found, then 409 with the status', async () => {
    await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'coord', kind: 'decide', text: 'Which store?' }).expect(201);
    await request(app).post(`/api/sessions/${sid}/ledger/N9/resolve`).send({ caller: 'coord', status: 'answered', quote: 'A' }).expect(404);
    const missing = await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: 'coord', status: 'answered', quote: 'A' }).expect(422);
    expect(missing.body.error).toBe("Quote not found in the user's messages to you after N1 was created. Do not record it. Ask the user.");
    messagesDb.append(db, { terminalId: 'coord', source: 'user', text: 'A please', sentAt: new Date(Date.now() + 1000).toISOString() });
    await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: 'coord', status: 'answered', quote: 'A please' }).expect(200);
    const again = await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: 'coord', status: 'parked', quote: 'A please' }).expect(409);
    expect(again.body).toEqual({ error: 'N1 is already answered.', status: 'answered' });
  });

  it('list, note, import and handoff answer on their routes', async () => {
    await request(app).post(`/api/sessions/${sid}/ledger/import`).send({ caller: 'coord', items: [{ kind: 'do', text: 'Check staging.' }] }).expect(201);
    const list = await request(app).post(`/api/sessions/${sid}/ledger/list`).send({ caller: 'coord', forRecap: true }).expect(200);
    expect(list.body.text).toContain('Your tests and actions:\n- N1 [Do] Check staging.');
    expect(JSON.parse(terminalsDb.getById(db, 'coord')!.config!).lastRecapAt).toEqual(expect.any(String));
    await request(app).post(`/api/sessions/${sid}/ledger/note`).send({ caller: 'coord', quote: 'never on Fridays' }).expect(422);
    const handoff = await request(app).post(`/api/sessions/${sid}/ledger/handoff`).send({ caller: 'coord', ids: ['N1'] }).expect(200);
    expect(handoff.body.block.startsWith('Owner decisions (verbatim, from the ledger):\n- N1 [Do] Check staging.')).toBe(true);
  });
});
