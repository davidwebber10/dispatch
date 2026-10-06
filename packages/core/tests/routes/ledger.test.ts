import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';
import { DECIDE_CARD, GO_CARD } from '../overseer/card-fixtures.js';

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
    const ok = await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'coord', kind: 'go', text: 'Merge PR #12.', ...GO_CARD }).expect(201);
    expect(ok.body.id).toBe('N1');
    expect(ok.body.line).toContain('N1 [Go] Merge PR #12.');
    const denied = await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'agent', kind: 'go', text: 'x', ...GO_CARD }).expect(403);
    expect(denied.body.error).toBe("Only the project's overseer can change the ledger.");
  });

  it('a card that fails a Unit 2 check is a 422 with the fixed text, and nothing is created', async () => {
    const missing = await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'coord', kind: 'go', text: 'Merge PR #12.' }).expect(422);
    expect(missing.body).toEqual({ error: 'A decision card needs: context (20 to 800 characters), default, source. Add them and try again.' });
    const range = await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'coord', kind: 'decide', text: 'Approve LR-1..LR-26?', ...DECIDE_CARD }).expect(422);
    expect(range.body.error).toBe('One decision per card. Add each decision on its own.');
    const source = await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'coord', kind: 'go', text: 'Merge PR #12.', ...GO_CARD, source: { kind: 'pr', ref: 'twelve' } }).expect(422);
    expect(source.body.error).toBe('The source does not exist in this project: twelve.');
    const imported = await request(app).post(`/api/sessions/${sid}/ledger/import`).send({ caller: 'coord', items: [{ kind: 'go', text: 'Merge PR #9.' }] }).expect(422);
    expect(imported.body).toEqual({ error: 'A decision card needs: context (20 to 800 characters), default, source. Add them and try again.', item: 0 });
    const list = await request(app).post(`/api/sessions/${sid}/ledger/list`).send({ caller: 'coord' }).expect(200);
    expect(list.body.openIds).toEqual([]);
  });

  it('resolve: 404 unknown, 422 quote not found, 200 found, then 409 with the status', async () => {
    await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'coord', kind: 'decide', text: 'Which store?', ...DECIDE_CARD }).expect(201);
    await request(app).post(`/api/sessions/${sid}/ledger/N9/resolve`).send({ caller: 'coord', status: 'answered', quote: 'A' }).expect(404);
    const missing = await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: 'coord', status: 'answered', quote: 'A' }).expect(422);
    expect(missing.body.error).toBe("Quote not found in the user's messages to you after N1 was created. Do not record it. Ask the user.");
    messagesDb.append(db, { terminalId: 'coord', source: 'user', text: 'A please', sentAt: new Date(Date.now() + 1000).toISOString() });
    await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: 'coord', status: 'answered', quote: 'A please' }).expect(200);
    const again = await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: 'coord', status: 'parked', quote: 'A please' }).expect(409);
    expect(again.body).toEqual({ error: 'N1 is already answered.', status: 'answered' });
  });

  it('every ledger route refuses a caller that is not the overseer: 403 with the fixed text, nothing changes', async () => {
    await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'coord', kind: 'decide', text: 'Which store?', ...DECIDE_CARD }).expect(201);
    messagesDb.append(db, { terminalId: 'coord', source: 'user', text: 'never on Fridays', sentAt: new Date(Date.now() + 1000).toISOString() });
    // Valid bodies, so only the caller check can refuse them.
    const routes: [string, Record<string, unknown>][] = [
      ['ledger', { kind: 'go', text: 'Merge PR #12.', ...GO_CARD }],
      ['ledger/list', { forRecap: true }],
      ['ledger/note', { quote: 'never on Fridays' }],
      ['ledger/import', { items: [{ kind: 'do', text: 'Check staging.' }] }],
      ['ledger/handoff', { ids: ['N1'] }],
      ['ledger/N1/resolve', { status: 'withdrawn', reason: 'moot' }],
    ];
    for (const caller of ['agent', undefined]) {
      for (const [route, body] of routes) {
        const res = await request(app).post(`/api/sessions/${sid}/${route}`).send({ ...body, caller });
        expect(res.status, `${route} as ${caller}`).toBe(403);
        expect(res.body, `${route} as ${caller}`).toEqual({ error: "Only the project's overseer can change the ledger." });
      }
    }
    const list = await request(app).post(`/api/sessions/${sid}/ledger/list`).send({ caller: 'coord' }).expect(200);
    expect(list.body.openIds).toEqual(['N1']);
    expect(JSON.parse(terminalsDb.getById(db, 'coord')!.config!).lastRecapAt).toBeUndefined();
  });

  it('list stamps lastRecapAt only for forRecap: true (a boolean), never for "yes"', async () => {
    await request(app).post(`/api/sessions/${sid}/ledger/list`).send({ caller: 'coord', forRecap: 'yes' }).expect(200);
    expect(JSON.parse(terminalsDb.getById(db, 'coord')!.config!).lastRecapAt).toBeUndefined();
    await request(app).post(`/api/sessions/${sid}/ledger/list`).send({ caller: 'coord', forRecap: true }).expect(200);
    expect(JSON.parse(terminalsDb.getById(db, 'coord')!.config!).lastRecapAt).toEqual(expect.any(String));
  });

  it('add with supersedes: the old open item becomes superseded and the new line shows the original question', async () => {
    for (const text of ['Merge PR #1.', 'Merge PR #2.', 'Set the first store to Draft?']) {
      await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'coord', kind: 'decide', text, ...DECIDE_CARD }).expect(201);
    }
    const wider = await request(app).post(`/api/sessions/${sid}/ledger`)
      .send({ caller: 'coord', kind: 'decide', text: 'Also set the second store to Draft?', ...DECIDE_CARD, supersedes: 'N3' }).expect(201);
    expect(wider.body.id).toBe('N4');
    expect(wider.body.line).toContain('\n  Original question (N3): "Set the first store to Draft?"');
    const list = await request(app).post(`/api/sessions/${sid}/ledger/list`).send({ caller: 'coord' }).expect(200);
    expect(list.body.openIds).toEqual(['N1', 'N2', 'N4']);
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
