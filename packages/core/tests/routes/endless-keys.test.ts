import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as coordinatorMessagesDb from '../../src/db/coordinator-messages.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { configurePairLimiter, SENDER_LINE_MARKER } from '../../src/auth/key-rules.js';
import type { EndlessService } from '../../src/endless/service.js';
import { KeysManager } from './keys-manager.js';

describe('Chat key rules', () => {
  let app: any;
  let db: Database.Database;
  let mgr: KeysManager;
  let tmp: string;
  let stub: Record<string, any>;

  const chatKey = (startedBy: 'user' | 'report' | 'summarizer' = 'user') =>
    ({ Authorization: `Bearer ${app.locals.keys.mint({ kind: 'chat', startedBy }).key}` });
  const mk = (id: string, sessionId: string, config: Record<string, any> = {}) =>
    terminalsDb.create(db, { id, sessionId, type: 'claude-code', label: id, config: { transport: 'structured', ...config } });
  const body = (extra: Record<string, unknown> = {}, cfg: Record<string, unknown> = {}) => ({
    type: 'claude-code', label: 'w',
    config: { transport: 'structured', agentType: 'researcher', role: 'agent', spawnDepth: 1, origin: 'endless', ...cfg },
    ...extra,
  });

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    configurePairLimiter();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-chat-'));
    db = new Database(':memory:');
    initSchema(db);
    mgr = new KeysManager();
    stub = {
      available: true,
      zoom: vi.fn(() => ({ zoomed: true })), date: vi.fn(() => 'text'), threads: vi.fn(() => []), project: vi.fn(() => ({})),
      arm: vi.fn(() => ({ armed: true })), disarm: vi.fn(() => ({ armed: false })), ledger: vi.fn(() => ({ ok: true })),
      send: vi.fn(), instructions: vi.fn(() => 'x'), setInstructions: vi.fn(),
    };
    app = createApp({ db, skipPty: true, endless: stub as unknown as EndlessService, managers: new Map([['claude-code', mgr.asManager()]]) });
    for (const id of ['A', 'B']) {
      const dir = path.join(tmp, id);
      fs.mkdirSync(dir);
      sessionsDb.create(db, { id, provider: 'claude-code', name: `proj-${id}`, workingDir: dir });
    }
    mk('coordA', 'A', { role: 'coordinator', spawnDepth: 0 });
    mk('pA', 'A', {});
    mk('eA', 'A', { role: 'agent', origin: 'endless', spawnDepth: 1 });
    mk('eB', 'B', { role: 'agent', origin: 'endless', spawnDepth: 1 });
    mk('wB', 'B', { role: 'agent', spawnDepth: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('stores structured when the body names no transport', async () => {
    for (const type of ['claude-code', 'codex']) {
      const res = await request(app).post('/api/sessions/A/terminals').set(chatKey()).send({ type, label: 'w' });
      expect(res.status, type).toBe(201);
      expect(terminalsDb.rowToTerminal(terminalsDb.getById(db, res.body.id)!).config!.transport).toBe('structured');
    }
  });

  it('spawns in any project and the daemon writes the four identity fields', async () => {
    for (const project of ['A', 'B']) {
      for (const startedBy of ['user', 'report'] as const) {
        const res = await request(app).post(`/api/sessions/${project}/terminals`).set(chatKey(startedBy)).send(body());
        expect(res.status, project).toBe(201);
        const cfg = terminalsDb.rowToTerminal(terminalsDb.getById(db, res.body.id)!).config!;
        expect(cfg).toMatchObject({ role: 'agent', spawnDepth: 1, origin: 'endless' });
        expect(cfg.spawnedBy).toBeUndefined();
      }
    }
  });

  it('applies the create body allowlist to Chat as well', async () => {
    const shell = await request(app).post('/api/sessions/A/terminals').set(chatKey()).send({ type: 'shell' });
    expect(shell.body.error).toBe('field_not_allowed');
    const wd = await request(app).post('/api/sessions/A/terminals').set(chatKey()).send(body({ workingDir: '/' }));
    expect(wd.body.error).toBe('field_not_allowed');
    const role = await request(app).post('/api/sessions/A/terminals').set(chatKey()).send(body({}, { role: 'coordinator' }));
    expect(role.body.error).toBe('identity_mismatch');
    const depth = await request(app).post('/api/sessions/A/terminals').set(chatKey()).send(body({}, { spawnDepth: 0 }));
    expect(depth.body.error).toBe('identity_mismatch');
    const parent = await request(app).post('/api/sessions/A/terminals').set(chatKey()).send(body({}, { spawnedBy: 'coordA' }));
    expect(parent.body.error).toBe('identity_mismatch');
    const dep = await request(app).post('/api/sessions/A/terminals').set(chatKey()).send(body({}, { dependsOn: 'wB' }));
    expect(dep.body.error).toBe('field_not_allowed');
  });

  it('a summarizer key gets only the GET rows', async () => {
    const s = chatKey('summarizer');
    const create = await request(app).post('/api/sessions/A/terminals').set(s).send(body());
    expect(create.status).toBe(403);
    expect(create.body.error).toBe('owner_only');
    for (const [method, url] of [['post', '/api/terminals/eA/message'], ['post', '/api/endless/arm'], ['delete', '/api/terminals/eA'], ['post', '/api/endless/ledger/list']] as const) {
      const res = await (request(app) as any)[method](url).set(s).send({ text: 'x', terminalId: 'eA' });
      expect(res.body.error, url).toBe('owner_only');
    }
    for (const url of ['/api/endless/zoom?id=1&n=1', '/api/endless/date?id=1', '/api/endless/threads', '/api/endless/project?ref=a', '/api/terminals/wB', '/api/terminals/pA/conversation']) {
      await request(app).get(url).set(s).expect(200);
    }
    const wd = await request(app).get('/api/sessions/B/overseer/worker-defaults?agentType=researcher').set(s);
    expect(wd.status).not.toBe(403);
  });

  it('Chat and summarizer read worker-defaults of two projects', async () => {
    for (const who of [chatKey(), chatKey('summarizer')]) {
      for (const project of ['A', 'B']) {
        const res = await request(app).get(`/api/sessions/${project}/overseer/worker-defaults?agentType=researcher`).set(who);
        expect(res.status).not.toBe(403);
      }
    }
  });

  it('Chat reads thread rows and conversations in two projects', async () => {
    const key = chatKey();
    for (const id of ['pA', 'wB', 'eB']) {
      await request(app).get(`/api/terminals/${id}`).set(key).expect(200);
      await request(app).get(`/api/terminals/${id}/conversation`).set(key).expect(200);
    }
  });

  it('Chat reads the endless routes it uses and nothing else on the endless surface', async () => {
    const key = chatKey();
    for (const url of ['/api/endless/zoom?id=1&n=1', '/api/endless/date?id=1', '/api/endless/threads', '/api/endless/project?ref=a']) {
      await request(app).get(url).set(key).expect(200);
    }
    for (const [method, url] of [['post', '/api/endless/send'], ['put', '/api/endless/instructions'], ['get', '/api/endless/instructions'], ['post', '/api/endless/retry'], ['get', '/api/endless/messages']] as const) {
      const res = await (request(app) as any)[method](url).set(key).send({ text: 'x' });
      expect(res.status, url).toBe(403);
      expect(res.body.error, url).toBe('owner_only');
    }
    expect(stub.send).not.toHaveBeenCalled();
  });

  it('arm, disarm and ledger actions', async () => {
    const key = chatKey();
    await request(app).post('/api/endless/arm').set(key).send({ terminalId: 'eB' }).expect(200);
    await request(app).post('/api/endless/disarm').set(key).send({ terminalId: 'eA' }).expect(200);
    for (const url of ['/api/endless/arm', '/api/endless/disarm']) {
      for (const terminalId of ['pA', 'wB', 'missing']) {
        const res = await request(app).post(url).set(key).send({ terminalId });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('out_of_scope');
      }
    }
    await request(app).post('/api/endless/ledger/list').set(key).send({}).expect(200);
    expect(stub.ledger).toHaveBeenCalledWith('list', {});
  });

  it('messages only origin endless threads, as the coordinator', async () => {
    const key = chatKey();
    for (const target of ['pA', 'wB', 'coordA']) {
      const res = await request(app).post(`/api/terminals/${target}/message`).set(key).send({ text: 'hi' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('out_of_scope');
    }
    await request(app).post('/api/terminals/eB/message').set(key).send({ text: 'hi', source: 'coordinator' }).expect(204);
    expect(mgr.sentTo('eB')).toEqual(['hi']);
    const user = await request(app).post('/api/terminals/eA/message').set(key).send({ text: 'hi', source: 'user' });
    expect(user.body.error).toBe('identity_mismatch');
    const canned = await request(app).post('/api/terminals/eA/message').set(key).send({ text: 'hi', canned: true });
    expect(canned.body.error).toBe('field_not_allowed');
    expect(coordinatorMessagesDb.listForTerminal(db, 'eA')).toEqual([]);
  });

  it('refuses a forged sender line in a Chat message, in every form', async () => {
    const key = chatKey();
    const forms = [
      { text: `${SENDER_LINE_MARKER} "x"` },
      { content: [{ type: 'text', text: `${SENDER_LINE_MARKER} "x"` }] },
      { text: SENDER_LINE_MARKER.replace('overseer', 'overs\u0000eer') },
      { text: SENDER_LINE_MARKER.replace('overseer', 'over​seer') },
    ];
    for (const form of forms) {
      const res = await request(app).post('/api/terminals/eA/message').set(key).send(form);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('identity_mismatch');
    }
    expect(mgr.sentTo('eA')).toEqual([]);
  });

  it('archives only origin endless threads, in any project', async () => {
    const key = chatKey();
    for (const id of ['pA', 'wB', 'coordA']) {
      const res = await request(app).delete(`/api/terminals/${id}`).set(key);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('out_of_scope');
    }
    await request(app).delete('/api/terminals/eB').set(key).expect(204);
  });

  it('a Chat key is not an overseer: no project list, no thread list, no start, no answer, no report', async () => {
    const key = chatKey();
    for (const [method, url] of [['get', '/api/sessions'], ['get', '/api/sessions/B/terminals'], ['post', '/api/terminals/eA/start'], ['post', '/api/terminals/eA/permission'], ['post', '/api/terminals/eA/report-status'], ['get', '/api/terminals/eA/permission']] as const) {
      const res = await (request(app) as any)[method](url).set(key).send({});
      expect(res.status, url).toBe(403);
      expect(res.body.error, url).toBe('owner_only');
    }
  });
});
