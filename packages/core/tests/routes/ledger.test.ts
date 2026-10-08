import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';
import * as ledgerDb from '../../src/db/ledger.js';
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
    expect(ok.body.line.startsWith('**N1 · Go:** Merge PR #12.\n\n')).toBe(true); // the full card
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
      ['ledger/show', { all: true }],
      ['ledger/N1/add-from-agent', { note: 'x' }],
      ['ledger/N1/decide-self', { choice: 'A', reason: 'x' }],
      ['ledger/N1/mark-default', {}],
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
    expect(wider.body.line).toContain('\n\n**Original question (N3):** "Set the first store to Draft?"\n\n');
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

  // Overseer memory scope (spec 2026-10-07), Unit 5: the rules are one line; the full list is a field.
  it('list carries the rules line and the rules field; show answers rules: true', async () => {
    messagesDb.append(db, { terminalId: 'coord', source: 'user', text: 'never deploy on Fridays', sentAt: new Date().toISOString() });
    await request(app).post(`/api/sessions/${sid}/ledger/note`).send({ caller: 'coord', quote: 'never deploy on Fridays', policy: true }).expect(201);
    const list = await request(app).post(`/api/sessions/${sid}/ledger/list`).send({ caller: 'coord' }).expect(200);
    expect(list.body.text.startsWith('Project rules: 1 in force (type "show rules").')).toBe(true);
    expect(list.body.rules).toEqual([expect.stringMatching(/^N1 You said: "never deploy on Fridays"/)]);
    const shown = await request(app).post(`/api/sessions/${sid}/ledger/show`).send({ caller: 'coord', rules: true }).expect(200);
    expect(shown.body.text.startsWith('Project rules (your words):\n- N1 You said: "never deploy on Fridays"')).toBe(true);
  });

  it('decision cards: add-from-agent, decide-self, mark-default and show answer on their routes', async () => {
    for (const text of ['How many nights?', 'Which day?']) {
      ledgerDb.create(db, { sessionId: sid, kind: 'decide', text, author: 'planner', status: 'proposed', ...{ context: DECIDE_CARD.context, defaultText: DECIDE_CARD.default } });
    }
    const sent = await request(app).post(`/api/sessions/${sid}/ledger/N1/add-from-agent`).send({ caller: 'coord', note: 'Mind the freeze.' }).expect(200);
    expect(sent.body).toEqual({ id: 'N1', status: 'open' });
    const decided = await request(app).post(`/api/sessions/${sid}/ledger/N2/decide-self`).send({ caller: 'coord', choice: 'Monday', reason: 'quiet day' }).expect(200);
    expect(decided.body.status).toBe('decided_by_overseer');
    const protectedItem = await request(app).post(`/api/sessions/${sid}/ledger/N1/decide-self`).send({ caller: 'coord', choice: 'x', reason: 'y' }).expect(422);
    expect(protectedItem.body.error).toBe('Only the user can decide this item.');
    const onDefault = await request(app).post(`/api/sessions/${sid}/ledger/N1/mark-default`).send({ caller: 'coord' }).expect(200);
    expect(onDefault.body.line).toContain('Running on the default');
    const shown = await request(app).post(`/api/sessions/${sid}/ledger/show`).send({ caller: 'coord', ids: ['N1'] }).expect(200);
    expect(shown.body.text.startsWith('**N1 · Decide:** How many nights?')).toBe(true);
    expect(shown.body.text).toContain("**Overseer's note:** Mind the freeze.");
  });

  // Pinned card spec 2026-10-08, Unit 2: the read-only card route.
  describe('GET /ledger/card', () => {
    it('returns the sections as card items, the rules and the index; no caller is needed', async () => {
      messagesDb.append(db, { terminalId: 'coord', source: 'user', text: 'never deploy on Fridays', sentAt: new Date().toISOString() });
      await request(app).post(`/api/sessions/${sid}/ledger/note`).send({ caller: 'coord', quote: 'never deploy on Fridays', policy: true }).expect(201);
      await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'coord', kind: 'decide', text: 'How many clean nights before live mode?', ...DECIDE_CARD }).expect(201);
      await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'coord', kind: 'go', text: 'Merge PR #12?', ...GO_CARD }).expect(201);
      await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'coord', kind: 'do', text: 'Check the banner on staging.' }).expect(201);
      const res = await request(app).get(`/api/sessions/${sid}/ledger/card`).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['index', 'lastRecapAt', 'rules', 'sections', 'updatedAt']);
      expect(res.body.lastRecapAt).toBeNull();
      expect(res.body.updatedAt).toEqual(expect.any(String));
      const [decide, go] = res.body.sections.needsYou.cards;
      expect(decide).toMatchObject({
        seq: 2, kind: 'decide', status: 'open', text: 'How many clean nights before live mode?', isNew: true,
        recommendation: 'A. 5 nights', default: DECIDE_CARD.default, source: { kind: 'overseer', ref: null, path: null, section: null, id: null },
      });
      expect(decide.options.map((o: { answerKey: string }) => o.answerKey)).toEqual(['A', 'B']);
      expect(go).toMatchObject({ seq: 3, kind: 'go', options: [] });
      expect(res.body.sections.actions.map((i: { seq: number }) => i.seq)).toEqual([4]);
      expect(res.body.rules).toEqual([{ seq: 1, quote: 'never deploy on Fridays', reading: null }]);
      expect(res.body.index.map((i: { seq: number }) => i.seq)).toEqual([1, 2, 3, 4]);
    });

    it('only reads: lastRecapAt and the interim timer stay as they are', async () => {
      const cfg = { role: 'coordinator', lastRecapAt: '2026-10-08T10:00:00.000Z', interimDueAt: '2026-10-08T10:20:00.000Z' };
      terminalsDb.updateConfig(db, 'coord', cfg);
      await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: 'coord', kind: 'do', text: 'Check staging.' }).expect(201);
      const before = ledgerDb.listBySession(db, sid);
      const res = await request(app).get(`/api/sessions/${sid}/ledger/card`).expect(200);
      expect(res.body.lastRecapAt).toBe('2026-10-08T10:00:00.000Z');
      expect(JSON.parse(terminalsDb.getById(db, 'coord')!.config!)).toEqual(cfg);
      expect(ledgerDb.listBySession(db, sid)).toEqual(before);
    });

    it('takes lastRecapAt from the live overseer, not an archived one', async () => {
      terminalsDb.updateConfig(db, 'coord', { role: 'coordinator', lastRecapAt: '2026-10-08T10:00:00.000Z' });
      terminalsDb.archive(db, 'coord');
      terminalsDb.create(db, { id: 'coord2', sessionId: sid, type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
      expect((await request(app).get(`/api/sessions/${sid}/ledger/card`).expect(200)).body.lastRecapAt).toBeNull();
    });

    it('a project with no ledger returns empty sections; an unknown project is a 404', async () => {
      const empty = await request(app).get(`/api/sessions/${sid}/ledger/card`).expect(200);
      expect(empty.body).toEqual({
        updatedAt: null, lastRecapAt: null,
        sections: { rulesCount: 0, needsYou: { cards: [], lines: [] }, onDefaults: [], actions: [], decidedSince: [], untriaged: [], parked: [], counts: { overseerDecisions: 0, reversed: 0 } },
        rules: [], index: [],
      });
      const missing = await request(app).get('/api/sessions/no-such-project/ledger/card').expect(404);
      expect(missing.body).toEqual({ error: 'Unknown project: no-such-project' });
    });
  });

  it('decide-self without an item ID creates an item that is already decided (201); its checks are 422s', async () => {
    const own = {
      text: 'Which retry helper?', ...DECIDE_CARD, choice: 'A. 5 nights', reason: 'it covers one weekend',
    };
    const created = await request(app).post(`/api/sessions/${sid}/ledger/decide-self`).send({ caller: 'coord', ...own }).expect(201);
    expect(created.body).toMatchObject({ id: 'N1', status: 'decided_by_overseer' });
    expect(ledgerDb.getBySeq(db, sid, 1)).toMatchObject({ status: 'decided_by_overseer', sentAt: null, decidedChoice: 'A. 5 nights' });
    const go = await request(app).post(`/api/sessions/${sid}/ledger/decide-self`).send({ caller: 'coord', ...own, kind: 'go' }).expect(422);
    expect(go.body.error).toBe('Only the user can decide this item.');
    await request(app).post(`/api/sessions/${sid}/ledger/decide-self`).send({ caller: 'agent', ...own }).expect(403);
  });
});
