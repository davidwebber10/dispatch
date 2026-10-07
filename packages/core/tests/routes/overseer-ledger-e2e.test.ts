// End to end (fake CLI, as in structured.test.ts): the overseer message log and the decision
// ledger through the real routes, managers, and notice path.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '../structured/fake-claude.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: any;
let db: Database.Database;
let dir: string;
let cfgDir: string;
let sid: string;
let coordId: string;
let agentId: string;

async function until(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error('timeout waiting for condition');
}

beforeEach(async () => {
  db = new Database(':memory:');
  initSchema(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-e2e-'));
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-e2e-cfg-')); // never the real ~/.dispatch
  app = createApp({ db, skipPty: true, secretsDir: cfgDir, structuredCommand: { command: process.execPath, args: [fake] } });
  sid = (await request(app).post('/api/sessions').send({ provider: 'claude-code', workingDir: dir, name: 'ledger-e2e' })).body.id;
  coordId = (await request(app).post(`/api/sessions/${sid}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', role: 'coordinator' } })).body.id;
  agentId = (await request(app).post(`/api/sessions/${sid}/terminals`).send({ type: 'claude-code', config: { transport: 'structured', agentType: 'researcher', role: 'agent', mission: 'Repo map' } })).body.id;
  await until(() => (db.prepare('SELECT external_id FROM terminals WHERE id = ?').get(coordId) as { external_id: string | null }).external_id === 'sess-fake');
});

afterEach(() => {
  app?._structuredManager?.killAll?.();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

describe('overseer ledger — end to end', () => {
  it('a human send is logged as user, and an agent notice as daemon with the Batch line', async () => {
    await request(app).post(`/api/terminals/${coordId}/message`).send({ text: 'Map the repo, please.', source: 'user' }).expect(204);
    await request(app).post(`/api/terminals/${agentId}/message`).send({ text: 'map the repo' }).expect(204);
    await until(() => messagesDb.listForTerminal(db, coordId).some((m) => m.source === 'daemon' && m.text.includes('finished a turn')));

    const log = messagesDb.listForTerminal(db, coordId);
    expect(log.find((m) => m.text === 'Map the repo, please.')?.source).toBe('user');
    const notice = log.find((m) => m.source === 'daemon' && m.text.includes(agentId))!;
    expect(notice.text).toContain('Batch: no other agent is working or queued.');
    expect(notice.text).toContain('Open ledger items: none.');
    expect(messagesDb.listForTerminal(db, agentId)).toEqual([]); // only overseers are logged
  });

  it('a quote resolves end to end against the user\'s real message', async () => {
    const add = await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: coordId, kind: 'decide', text: 'Which store goes first?', options: ['A', 'B'] }).expect(201);
    expect(add.body.id).toBe('N1');
    await sleep(5); // the answer must come strictly after the item
    await request(app).post(`/api/terminals/${coordId}/message`).send({ text: 'N1: A, but only for the first store', source: 'user' }).expect(204);

    const res = await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: coordId, status: 'answered', quote: 'a, BUT only   for the first store' }).expect(200);
    expect(res.body.line).toContain('You approved: "Which store goes first?" → "A, but only for the first store"');
    const list = await request(app).post(`/api/sessions/${sid}/ledger/list`).send({ caller: coordId }).expect(200);
    expect(list.body.text).toContain('Decided since the last recap:\n- N1 [Decide] Which store goes first?');
  });

  it('an "ok"-only answer, a canned click, and a non-overseer caller all fail', async () => {
    await request(app).post(`/api/sessions/${sid}/ledger`).send({ caller: coordId, kind: 'decide', text: 'Use library A?' }).expect(201);
    await sleep(5);
    await request(app).post(`/api/terminals/${coordId}/message`).send({ text: 'ok', source: 'user' }).expect(204);
    await request(app).post(`/api/terminals/${coordId}/message`).send({ text: '“Use A” — got it.', source: 'user', canned: true }).expect(204);

    const okOnly = await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: coordId, status: 'answered', quote: 'ok' }).expect(422);
    expect(okOnly.body.error).toBe("An 'ok' at the start of a message is not an answer. Ask the user.");
    const canned = await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: coordId, status: 'answered', quote: 'Use A' }).expect(422);
    expect(canned.body.error).toBe("Quote not found in the user's messages to you after N1 was created. Do not record it. Ask the user.");
    const denied = await request(app).post(`/api/sessions/${sid}/ledger/N1/resolve`).send({ caller: agentId, status: 'withdrawn', reason: 'x' }).expect(403);
    expect(denied.body.error).toBe("Only the project's overseer can change the ledger.");
    expect(messagesDb.listForTerminal(db, coordId).map((m) => m.source)).toEqual(['user', 'canned']);
  });
});
