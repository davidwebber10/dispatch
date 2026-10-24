import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as watchesDb from '../../src/db/watches.js';
import * as ledgerDb from '../../src/db/ledger.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { GO_CARD } from '../overseer/card-fixtures.js';

describe('watches, ledger, events and auth-request rules for keys', () => {
  let app: any;
  let db: Database.Database;
  const mint = (id: string) => app.locals.keys.mint({ kind: 'thread', terminalId: id }).key as string;
  const as = (id: string) => ({ Authorization: `Bearer ${mint(id)}` });
  const mk = (id: string, sessionId: string, config: Record<string, any> = {}, type = 'claude-code') =>
    terminalsDb.create(db, { id, sessionId, type, label: id, config });

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    for (const id of ['A', 'B']) sessionsDb.create(db, { id, provider: 'claude-code', name: `proj-${id}`, workingDir: '/tmp' });
    mk('coordA', 'A', { role: 'coordinator', spawnDepth: 0 });
    mk('wA', 'A', { role: 'agent', spawnedBy: 'coordA', spawnDepth: 1 });
    mk('wA2', 'A', { role: 'agent', spawnedBy: 'coordA', spawnDepth: 1 });
    mk('cxA', 'A', { role: 'agent', spawnedBy: 'coordA', spawnDepth: 1 }, 'codex');
    mk('shA', 'A', {}, 'shell');
    mk('coordB', 'B', { role: 'coordinator', spawnDepth: 0 });
    mk('wB', 'B', { role: 'agent', spawnedBy: 'coordB', spawnDepth: 1 });
    terminalsDb.updateSortOrder(db, 'coordA', 1);
    terminalsDb.updateSortOrder(db, 'coordB', 1);
  });

  describe('watches', () => {
    const watch = (extra: Record<string, unknown> = {}) => ({ targetTerminalId: 'wA2', criteria: 'idle', ...extra });

    it('POST fills in the watcher; a forged watcher is refused', async () => {
      const ok = await request(app).post('/api/watches').set(as('wA')).send(watch());
      expect(ok.status).toBe(201);
      expect(watchesDb.listByWatcher(db, 'wA')).toHaveLength(1);
      const same = await request(app).post('/api/watches').set(as('wA')).send(watch({ watcherTerminalId: 'wA' }));
      expect(same.status).toBe(201);
      const forged = await request(app).post('/api/watches').set(as('wA')).send(watch({ watcherTerminalId: 'coordA' }));
      expect(forged.status).toBe(403);
      expect(forged.body.error).toBe('identity_mismatch');
      expect(watchesDb.listByWatcher(db, 'coordA')).toHaveLength(0);
    });

    it('POST target must be in the caller project, for an overseer too', async () => {
      for (const who of ['wA', 'coordA']) {
        const res = await request(app).post('/api/watches').set(as(who)).send(watch({ targetTerminalId: 'wB' }));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('out_of_scope');
      }
      expect(watchesDb.listByWatcher(db, 'coordA')).toHaveLength(0);
    });

    it('GET returns only the caller watches and refuses another watcher or target', async () => {
      watchesDb.create(db, { watcherTerminalId: 'wA', targetTerminalId: 'wA2', criteria: 'idle' });
      watchesDb.create(db, { watcherTerminalId: 'coordA', targetTerminalId: 'wA', criteria: 'idle' });
      const mine = await request(app).get('/api/watches').set(as('wA')).expect(200);
      expect(mine.body.watching).toHaveLength(1);
      expect(mine.body.watching[0].watcher_terminal_id).toBe('wA');
      expect(mine.body.watchedBy).toHaveLength(1);
      expect(mine.body.watchedBy[0].watcher_terminal_id).toBe('coordA');
      for (const q of ['watcher=coordA', 'target=coordA']) {
        const res = await request(app).get(`/api/watches?${q}`).set(as('wA'));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('identity_mismatch');
      }
      await request(app).get('/api/watches?watcher=wA').set(as('wA')).expect(200);
    });

    it('DELETE works for the own watch only', async () => {
      const id = watchesDb.create(db, { watcherTerminalId: 'wA', targetTerminalId: 'wA2', criteria: 'idle' });
      const other = await request(app).delete(`/api/watches/${id}?watcher=wA`).set(as('coordA'));
      expect(other.status).toBe(403);
      expect(other.body.error).toBe('identity_mismatch');
      const foreign = await request(app).delete(`/api/watches/${id}`).set(as('coordA'));
      expect(foreign.status).toBe(404);
      await request(app).delete(`/api/watches/${id}`).set(as('wA')).expect(200);
      expect(watchesDb.listByWatcher(db, 'wA')).toHaveLength(0);
    });

    it('the owner path is unchanged', async () => {
      await request(app).post('/api/watches').send({ watcherTerminalId: 'wA', targetTerminalId: 'wA2', criteria: 'idle' }).expect(201);
      await request(app).get('/api/watches?watcher=wA').expect(200);
    });
  });

  describe('ledger', () => {
    const post = (who: string | null, project: string, suffix: string, body: Record<string, unknown>) => {
      const r = request(app).post(`/api/sessions/${project}/ledger${suffix}`);
      return (who ? r.set(as(who)) : r).send(body);
    };

    it('the coordinator key needs no caller; the daemon sets it', async () => {
      const ok = await post('coordA', 'A', '', { kind: 'go', text: 'Merge PR #12.', ...GO_CARD, title: 'Merge PR #12' });
      expect(ok.status).toBe(201);
      expect(ok.body.id).toBe('N1');
      const own = await post('coordA', 'A', '', { caller: 'coordA', kind: 'go', text: 'Merge PR #13.', ...GO_CARD, title: 'Merge PR #13' });
      expect(own.status).toBe(201);
    });

    it('a worker key with the coordinator id as caller is refused; with no caller it fails the overseer check', async () => {
      const forged = await post('wA', 'A', '', { caller: 'coordA', kind: 'go', text: 'x', ...GO_CARD });
      expect(forged.status).toBe(403);
      expect(forged.body.error).toBe('identity_mismatch');
      expect(ledgerDb.getBySeq(db, 'A', 1)).toBeFalsy();
      const plain = await post('wA', 'A', '', { kind: 'go', text: 'x', ...GO_CARD });
      expect(plain.status).toBe(403);
      expect(plain.body.error).toBe("Only the project's overseer can change the ledger.");
    });

    const routes: [string, string][] = [
      ['', 'POST'], ['/list', 'POST'], ['/note', 'POST'], ['/import', 'POST'], ['/handoff', 'POST'],
      ['/N1/resolve', 'POST'], ['/show', 'POST'], ['/decide-self', 'POST'], ['/N1/add-from-agent', 'POST'],
      ['/N1/decide-self', 'POST'], ['/N1/mark-default', 'POST'], ['/N1/title', 'POST'],
    ];
    it('an overseer cannot write another project ledger, on all 12 routes', async () => {
      expect(routes).toHaveLength(12);
      for (const [suffix] of routes) {
        const res = await post('coordA', 'B', suffix, {});
        expect(res.status, suffix).toBe(403);
        expect(res.body.error, suffix).toBe('out_of_scope');
      }
    });

    it('the two ledger GET routes stay owner only', async () => {
      for (const url of ['/api/sessions/A/ledger/card', '/api/sessions/A/ledger/N1/source']) {
        const res = await request(app).get(url).set(as('coordA'));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('owner_only');
      }
    });

    it('the owner path is unchanged', async () => {
      await post(null, 'A', '/list', { caller: 'coordA' }).then((r) => expect(r.status).toBe(200));
    });
  });

  describe('events', () => {
    it('allows the caller and the matching provider only', async () => {
      await request(app).post('/api/events/claude/wA').set(as('wA')).send({ hook_event_name: 'Stop' }).expect(204);
      await request(app).post('/api/events/codex/cxA').set(as('cxA')).send({}).expect(204);
      for (const [url, who] of [['/api/events/claude/wA2', 'wA'], ['/api/events/codex/wA', 'wA'], ['/api/events/claude/cxA', 'cxA'], ['/api/events/grok/wA', 'wA']] as const) {
        const res = await request(app).post(url).set(as(who)).send({});
        expect(res.status, url).toBe(403);
        expect(res.body.error, url).toBe('out_of_scope');
      }
    });

    it('the owner and a credential-free caller still get 204', async () => {
      await request(app).post('/api/events/claude/wA').send({}).expect(204);
    });
  });

  describe('auth-requests', () => {
    const body = (extra: Record<string, unknown> = {}) => ({ url: 'https://example.com/login', source: 'test', ...extra });

    it('thread and shell keys: terminalId is set from the key', async () => {
      const res = await request(app).post('/api/auth-requests').set(as('wA')).send(body());
      expect(res.status).toBe(201);
      expect(res.body.terminalId).toBe('wA');
      const own = await request(app).post('/api/auth-requests').set(as('wA')).send(body({ terminalId: 'wA' }));
      expect(own.status).toBe(201);
      const forged = await request(app).post('/api/auth-requests').set(as('wA')).send(body({ terminalId: 'wA2' }));
      expect(forged.status).toBe(403);
      expect(forged.body.error).toBe('identity_mismatch');
      const shell = app.locals.keys.mint({ kind: 'shell', terminalId: 'shA' }).key;
      const sh = await request(app).post('/api/auth-requests').set('Authorization', `Bearer ${shell}`).send(body());
      expect(sh.status).toBe(201);
      expect(sh.body.terminalId).toBe('shA');
      const shForged = await request(app).post('/api/auth-requests').set('Authorization', `Bearer ${shell}`).send(body({ terminalId: 'wA' }));
      expect(shForged.body.error).toBe('identity_mismatch');
    });

    it('Chat keys: terminalId must be absent', async () => {
      const chat = app.locals.keys.mint({ kind: 'chat', startedBy: 'user' }).key;
      const auth = { Authorization: `Bearer ${chat}` };
      await request(app).post('/api/auth-requests').set(auth).send(body()).expect(201);
      const res = await request(app).post('/api/auth-requests').set(auth).send(body({ terminalId: 'wA' }));
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('identity_mismatch');
      const summarizer = app.locals.keys.mint({ kind: 'chat', startedBy: 'summarizer' }).key;
      const s = await request(app).post('/api/auth-requests').set('Authorization', `Bearer ${summarizer}`).send(body());
      expect(s.body.error).toBe('owner_only');
    });

    it('a shell key is refused on any other route', async () => {
      const shell = app.locals.keys.mint({ kind: 'shell', terminalId: 'shA' }).key;
      for (const [method, url] of [['get', '/api/terminals/wA'], ['get', '/api/watches'], ['get', '/api/auth-requests'], ['post', '/api/terminals/wA/message']] as const) {
        const res = await (request(app) as any)[method](url).set('Authorization', `Bearer ${shell}`).send({ text: 'x' });
        expect(res.status, url).toBe(403);
        expect(res.body.error, url).toBe('owner_only');
      }
    });

    it('the list route and the other auth-request routes stay owner only', async () => {
      const res = await request(app).get('/api/auth-requests').set(as('wA'));
      expect(res.body.error).toBe('owner_only');
    });
  });
});
