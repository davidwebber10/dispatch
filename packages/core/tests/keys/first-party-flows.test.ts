// Task 18: every tool that an agent or Chat uses today still works with its key.
// The real tool code (agency-mcp, memory-mcp) calls a real daemon app on a real port, one caller at
// a time, with DISPATCH_API and DISPATCH_AUTH set the way the daemon sets them for a thread.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { configurePairLimiter, SENDER_LINE_MARKER } from '../../src/auth/key-rules.js';
import { callTool as agencyCall, resetIdentityCache } from '../../src/overseer/agency-mcp.js';
import { callTool as memoryCall } from '../../src/endless/memory-mcp.js';
import type { EndlessService } from '../../src/endless/service.js';
import { KeysManager } from '../routes/keys-manager.js';
import { GO_CARD, DECIDE_CARD } from '../overseer/card-fixtures.js';

// The worker-defaults route probes the real CLI sign-in. These tests start no CLI, so say it is signed in.
vi.mock('../../src/setup/detect.js', async (orig) => ({
  ...(await orig<typeof import('../../src/setup/detect.js')>()),
  detectProvider: vi.fn(async () => ({ installed: true, signedIn: true })),
}));

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
const textOf = (r: Result) => r.content.map((c) => c.text ?? '').join('\n');

const ENV_NAMES = ['DISPATCH_API', 'DISPATCH_AUTH', 'DISPATCH_AUTH_FILE', 'DISPATCH_SESSION', 'DISPATCH_TERMINAL', 'DISPATCH_SPAWN_DEPTH', 'DISPATCH_PORT'];

describe('every first-party tool passes with its key', () => {
  let app: any;
  let db: Database.Database;
  let mgr: KeysManager;
  let server: Server;
  let base: string;
  let tmp: string;
  let stub: Record<string, any>;
  let statuses: { method: string; url: string; status: number }[];
  const keys = new Map<string, string>();
  const savedEnv: Record<string, string | undefined> = {};
  const realFetch = globalThis.fetch;

  const mk = (id: string, sessionId: string, config: Record<string, any> = {}, type = 'claude-code') =>
    terminalsDb.create(db, { id, sessionId, type, label: id, config: { transport: 'structured', ...config } });

  beforeAll(() => { for (const n of ENV_NAMES) savedEnv[n] = process.env[n]; });
  afterAll(() => { for (const n of ENV_NAMES) { if (savedEnv[n] === undefined) delete process.env[n]; else process.env[n] = savedEnv[n]; } });

  beforeEach(async () => {
    configureRefusalLog({ log: () => {} });
    configurePairLimiter();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-flows-'));
    tmp = fs.mkdtempSync(path.join(tmp, 'sb-'));
    db = new Database(':memory:');
    initSchema(db);
    mgr = new KeysManager();
    stub = {
      available: true,
      zoom: vi.fn(() => ({ text: 'zoomed', images: [] })), date: vi.fn(() => 'a date'), threads: vi.fn(() => []),
      project: vi.fn((ref: string) => {
        const id = String(ref).toLowerCase().includes('b') ? 'B' : 'A';
        return { id, name: `proj-${id}`, folder: path.join(tmp, id) };
      }),
      arm: vi.fn(() => ({ armed: true })), disarm: vi.fn(() => ({ armed: false })), ledger: vi.fn(() => ({ text: 'ledger', rules: [] })),
      send: vi.fn(), instructions: vi.fn(() => 'x'), setInstructions: vi.fn(),
    };
    app = createApp({ db, skipPty: true, endless: stub as unknown as EndlessService, managers: new Map([['claude-code', mgr.asManager()]]) });
    for (const id of ['A', 'B']) {
      fs.mkdirSync(path.join(tmp, id));
      sessionsDb.create(db, { id, provider: 'claude-code', name: `proj-${id}`, workingDir: path.join(tmp, id) });
    }
    mk('coordA', 'A', { role: 'coordinator', spawnDepth: 0 });
    mk('wA', 'A', { role: 'agent', agentType: 'implementer', spawnedBy: 'coordA', spawnDepth: 1 });
    mk('wA2', 'A', { role: 'agent', agentType: 'researcher', spawnedBy: 'coordA', spawnDepth: 1 });
    mk('kid', 'A', { role: 'agent', agentType: 'researcher', spawnedBy: 'wA', spawnDepth: 2 });
    mk('deep', 'A', { role: 'agent', agentType: 'researcher', spawnedBy: 'coordA', spawnDepth: 3 });
    mk('peerA', 'A', {});
    mk('rr', 'A', { role: 'agent', roleRun: 'nightly', spawnDepth: 0 });
    mk('eA', 'A', { role: 'agent', origin: 'endless', spawnDepth: 1 });
    mk('coordB', 'B', { role: 'coordinator', spawnDepth: 0 });
    mk('wB', 'B', { role: 'agent', agentType: 'researcher', spawnedBy: 'coordB', spawnDepth: 1 });
    mk('eB', 'B', { role: 'agent', origin: 'endless', spawnDepth: 1 });
    terminalsDb.updateSortOrder(db, 'coordA', 1);
    terminalsDb.updateSortOrder(db, 'coordB', 1);

    keys.clear();
    for (const id of ['coordA', 'wA', 'kid', 'deep', 'rr', 'eA', 'coordB', 'wB']) keys.set(id, app.locals.keys.mint({ kind: 'thread', terminalId: id }).key);
    keys.set('chat', app.locals.keys.mint({ kind: 'chat', startedBy: 'user' }).key);

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Record every status that a tool sees.
    statuses = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const res = await realFetch(input, init);
      statuses.push({ method: String(init?.method ?? 'GET'), url: String(input), status: res.status });
      return res;
    });
    for (const n of ENV_NAMES) delete process.env[n];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const n of ENV_NAMES) delete process.env[n];
    resetIdentityCache();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  });

  const DEPTH: Record<string, number> = { coordA: 0, wA: 1, kid: 2, deep: 3, rr: 0, eA: 1, coordB: 0, wB: 1 };
  const PROJECT: Record<string, string> = { coordA: 'A', wA: 'A', kid: 'A', deep: 'A', rr: 'A', eA: 'A', coordB: 'B', wB: 'B' };

  /** Become one thread: the env that the daemon gives it. */
  function become(id: string) {
    for (const n of ENV_NAMES) delete process.env[n];
    process.env.DISPATCH_API = base;
    process.env.DISPATCH_AUTH = keys.get(id)!;
    if (id !== 'chat') {
      process.env.DISPATCH_SESSION = PROJECT[id];
      process.env.DISPATCH_TERMINAL = id;
      process.env.DISPATCH_SPAWN_DEPTH = String(DEPTH[id]);
    }
    resetIdentityCache();
    statuses.length = 0;
  }

  /** Run a tool and require that no daemon answer was a key refusal. */
  async function ok(call: (n: string, a: any) => Promise<Result>, name: string, args: any = {}, expectError = false): Promise<Result> {
    const before = statuses.length;
    const r = await call(name, args);
    if (name !== 'post_image') expect(statuses.length, `${name} reached the daemon`).toBeGreaterThan(before);
    const refused = statuses.slice(before).filter((s) => s.status === 401 || s.status === 403 || s.status === 429);
    expect(refused, `${name}: ${JSON.stringify(refused)} ${textOf(r)}`).toEqual([]);
    if (!expectError) expect(r.isError, `${name}: ${textOf(r)}`).toBeUndefined();
    return r;
  }
  const agency = (name: string, args: any = {}, expectError = false) => ok(agencyCall as any, name, args, expectError);
  const memory = (name: string, args: any = {}, expectError = false) => ok(memoryCall as any, name, args, expectError);

  const question = { requestId: 'r1', toolName: 'AskUserQuestion', input: {}, questions: [{ question: 'Q?', header: 'H', options: [{ label: 'yes' }] }] };

  describe('the project coordinator', () => {
    it('passes every agency tool', async () => {
      become('coordA');
      const spawned = JSON.parse(textOf(await agency('spawn_agent', { agentType: 'researcher', task: 'Look at X', mission: 'M' })));
      expect(terminalsDb.getById(db, spawned.agentId)!.session_id).toBe('A');
      const queued = JSON.parse(textOf(await agency('queue_agent', { agentType: 'implementer', task: 'Build Y', mission: 'M' })));
      await agency('start_agent', { agentId: queued.agentId });
      expect(JSON.parse(textOf(await agency('list_agents'))).length).toBeGreaterThan(3);
      expect(JSON.parse(textOf(await agency('list_missions'))).length).toBeGreaterThan(0);
      await agency('message_agent', { agentId: 'wA', text: 'steer' });
      expect(mgr.sentTo('wA').join('\n')).toContain('steer');
      mgr.pending.set('wA2', question);
      await agency('answer_agent', { agentId: 'wA2', requestId: 'r1', answers: { H: 'yes' } });
      expect(mgr.answers).toHaveLength(1);
      await agency('read_agent', { agentId: 'wA' });
      await agency('list_threads');
      await agency('read_thread', { id: 'peerA' });
      await agency('message_thread', { id: 'peerA', text: 'hello peer' });
      const w = JSON.parse(textOf(await agency('watch_thread', { id: 'wA2', when: 'idle' })));
      expect(typeof w.watchId).toBe('string');
      await agency('list_watches');
      await agency('unwatch_thread', { watchId: w.watchId });
      await agency('complete_agent', { agentId: spawned.agentId });
    });

    it('passes report_status', async () => {
      become('coordA');
      vi.spyOn(app._sessionService, 'reportStatus').mockReturnValue(true);
      await agency('report_status', { state: 'done', summary: 'All done.' });
    });

    it('passes every ledger tool', async () => {
      become('coordA');
      const added = JSON.parse(textOf(await agency('ledger_add', { kind: 'go', text: 'Merge PR #12.', ...GO_CARD, title: 'Merge PR #12' })));
      expect(added.id).toBe('N1');
      await agency('ledger_add', { kind: 'go', text: 'Merge PR #13.', ...GO_CARD, title: 'Merge PR #13' });
      await agency('ledger_list', {});
      await agency('ledger_show', { all: true });
      await agency('ledger_show', { rules: true });
      await agency('ledger_set_title', { id: 'N1', title: 'Merge the twelve PR' });
      await agency('ledger_mark_default', { id: 'N1' });
      await agency('ledger_resolve', { id: 'N1', status: 'withdrawn', reason: 'No longer needed.' });
      await agency('ledger_import', { items: [{ kind: 'go', text: 'Old item.', ...GO_CARD, title: 'Old item here' }] });
      await agency('ledger_decide_self', { text: 'Use the safe path.', choice: 'A. 5 nights', reason: 'No risk.', ...DECIDE_CARD, title: 'Use the safe path' });
      // Domain answers (a quote that does not match, an agent with no proposal) are not key refusals.
      await agency('ledger_note', { quote: 'a quote that no user wrote' }, true);
      await agency('ledger_add_from_agent', { id: 'wA' }, true);
      // The hand-off block rides on spawn, queue and message.
      await agency('message_agent', { agentId: 'wA', text: 'with ledger', ledgerIds: ['N2'] });
    });

    it('passes post_image', async () => {
      become('coordA');
      // post_image reads the file from disk and makes no daemon call: a missing file is a plain error.
      const prev = process.cwd();
      process.chdir(tmp);
      try {
        fs.writeFileSync(path.join(tmp, 'shot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
        const r = await agency('post_image', { path: 'shot.png' });
        expect(r.content[0].type).toBe('image');
      } finally { process.chdir(prev); }
    });
  });

  describe('a worker', () => {
    it('passes the tools that a worker has', async () => {
      become('wA');
      const spawned = JSON.parse(textOf(await agency('spawn_agent', { agentType: 'researcher', task: 'Sub task' })));
      const queued = JSON.parse(textOf(await agency('queue_agent', { agentType: 'researcher', task: 'Later' })));
      await agency('start_agent', { agentId: queued.agentId });
      await agency('list_agents');
      await agency('list_missions');
      await agency('message_agent', { agentId: 'kid', text: 'steer the kid' });
      mgr.pending.set('kid', question);
      await agency('answer_agent', { agentId: 'kid', requestId: 'r1', answers: { H: 'yes' } });
      await agency('read_agent', { agentId: 'kid' });
      await agency('list_threads');
      await agency('read_thread', { id: 'peerA' });
      await agency('message_thread', { id: 'wA2', text: 'peer to peer' });
      const w = JSON.parse(textOf(await agency('watch_thread', { id: 'kid', when: 'idle' })));
      await agency('list_watches');
      await agency('unwatch_thread', { watchId: w.watchId });
      vi.spyOn(app._sessionService, 'reportStatus').mockReturnValue(true);
      await agency('report_status', { state: 'needs_you', summary: 's', ask: 'what?' });
      await agency('complete_agent', { agentId: spawned.agentId });
    });
  });

  describe('a role run', () => {
    it('passes the read, watch and report set', async () => {
      become('rr');
      await agency('list_threads');
      await agency('read_thread', { id: 'wA' });
      const w = JSON.parse(textOf(await agency('watch_thread', { id: 'wA', when: 'idle' })));
      await agency('list_watches');
      await agency('unwatch_thread', { watchId: w.watchId });
      vi.spyOn(app._sessionService, 'reportStatus').mockReturnValue(true);
      await agency('report_status', { state: 'done', summary: 's' });
    });
  });

  describe('an endless worker', () => {
    it('passes its own reports and reads', async () => {
      become('eA');
      await agency('list_threads');
      await agency('read_thread', { id: 'peerA' });
      const w = JSON.parse(textOf(await agency('watch_thread', { id: 'wA', when: 'idle' })));
      await agency('unwatch_thread', { watchId: w.watchId });
      vi.spyOn(app._sessionService, 'reportStatus').mockReturnValue(true);
      await agency('report_status', { state: 'done', summary: 's' });
    });
  });

  describe('Chat', () => {
    it('passes every memory tool, in both projects', async () => {
      become('chat');
      await memory('zoom', { id: 1, n: 1 });
      await memory('date', { id: 1 });
      await memory('list_threads');
      for (const id of ['peerA', 'wB', 'eB']) await memory('read_thread', { id });
      for (const project of ['A', 'B']) {
        const r = JSON.parse(textOf(await memory('spawn_agent', { project, agentType: 'researcher', task: `Look in ${project}` })));
        expect(terminalsDb.getById(db, r.agentId)!.session_id).toBe(project);
        expect(terminalsDb.rowToTerminal(terminalsDb.getById(db, r.agentId)!).config).toMatchObject({ origin: 'endless' });
      }
      await memory('message_thread', { id: 'eB', text: 'more please' });
      await memory('read_agent', { agentId: 'eA' });
      await memory('ledger_list', { project: 'A' });
      await memory('ledger_show', { project: 'A', ids: ['N1'] });
      await memory('ledger_add', { project: 'A', kind: 'go', text: 'x' });
      await memory('ledger_resolve', { project: 'A', id: 'N1', status: 'done' });
      await memory('ledger_set_title', { project: 'A', id: 'N1', title: 'A new title' });
      expect(stub.ledger).toHaveBeenCalled();
    });
  });

  describe('cross-project reach of an overseer (PK-4)', () => {
    it('lets the coordinator list, read and message the other overseer', async () => {
      become('coordA');
      const projects = JSON.parse(textOf(await agency('list_projects')));
      expect(projects.map((p: any) => p.id).sort()).toEqual(['A', 'B']);
      const rows = JSON.parse(textOf(await agency('list_threads', { projectId: 'B' })));
      expect(rows.map((r: any) => r.id)).toContain('wB');
      await agency('read_thread', { id: 'wB' });
      await agency('read_agent', { agentId: 'wB' });
      await agency('message_thread', { id: 'coordB', text: 'hello from A' });
      const got = mgr.sentTo('coordB').join('\n');
      expect(got).toContain(SENDER_LINE_MARKER);
      expect(got).toContain('hello from A');
    });

    it('gives a worker a readable out_of_scope error on the same calls', async () => {
      become('wA');
      for (const [name, args] of [
        ['list_projects', {}], ['list_threads', { projectId: 'B' }], ['read_thread', { id: 'wB' }],
        ['read_agent', { agentId: 'wB' }], ['message_thread', { id: 'coordB', text: 'hi' }],
      ] as const) {
        const r = await agencyCall(name, args);
        expect(r.isError, name).toBe(true);
        expect(textOf(r as Result), name).not.toMatch(/^Error: (GET|POST) /);
      }
      expect(mgr.sentTo('coordB')).toEqual([]);
    });

    it('keeps spawn in the own project and refuses a direct start, delete and answer in the other', async () => {
      become('coordA');
      const spawned = JSON.parse(textOf(await agency('spawn_agent', { agentType: 'researcher', task: 'Look', projectId: 'B', sessionId: 'B' })));
      expect(terminalsDb.getById(db, spawned.agentId)!.session_id).toBe('A');
      const auth = { Authorization: `Bearer ${keys.get('coordA')}` };
      mgr.pending.set('wB', question);
      for (const [method, url] of [['post', '/api/terminals/wB/start'], ['delete', '/api/terminals/wB'], ['post', '/api/terminals/wB/permission']] as const) {
        const res = await (request(app) as any)[method](url).set(auth).send({ decision: 'allow', requestId: 'r1', answers: { 'Q?': 'yes' } });
        expect(res.status, url).toBe(403);
        expect(res.body.error, url).toBe('out_of_scope');
      }
      expect(mgr.answers).toEqual([]);
    });
  });

  describe('forged calls (spec 9)', () => {
    const as = (id: string) => ({ Authorization: `Bearer ${keys.get(id)}` });
    const code = (res: request.Response, status: number, error: string) => {
      expect(res.status, JSON.stringify(res.body)).toBe(status);
      expect(res.body.error).toBe(error);
    };

    it('a worker cannot send as the user', async () => {
      code(await request(app).post('/api/terminals/kid/message').set(as('wA')).send({ text: 'x', source: 'user' }), 403, 'identity_mismatch');
    });
    it('a worker cannot name the coordinator as the ledger caller', async () => {
      const res = await request(app).post('/api/sessions/A/ledger').set(as('wA')).send({ caller: 'coordA', kind: 'go', text: 'x', ...GO_CARD });
      code(res, 403, 'identity_mismatch');
    });
    it('a worker cannot watch for a peer', async () => {
      const res = await request(app).post('/api/watches').set(as('wA')).send({ watcherTerminalId: 'wA2', targetTerminalId: 'kid', criteria: 'idle' });
      code(res, 403, 'identity_mismatch');
    });
    it('a spawn past depth 3 is refused', async () => {
      const body = { type: 'claude-code', label: 'w', config: { transport: 'structured', agentType: 'implementer', role: 'agent', mission: 'm', spawnDepth: 4, spawnedBy: 'deep' } };
      code(await request(app).post('/api/sessions/A/terminals').set(as('deep')).send(body), 403, 'depth_exceeded');
    });
    it('an answer to a held tool call is refused', async () => {
      mgr.pending.set('kid', { requestId: 'r9', toolName: 'Bash', input: { command: 'ls' } });
      const res = await request(app).post('/api/terminals/kid/permission').set(as('wA')).send({ decision: 'allow', requestId: 'r9' });
      code(res, 403, 'not_a_question');
      expect(mgr.answers).toEqual([]);
    });
    it('the owner-only routes answer owner_only to every thread key', async () => {
      const calls: [string, string, any][] = [
        ['post', '/api/secrets', { name: 'X', value: 'y' }],
        ['post', '/api/roles/nightly/enable', {}],
        ['post', '/api/claude-auth/login', {}],
        ['post', '/api/integrations', { name: 'x' }],
        ['post', '/api/terminals/kid/input', { data: 'ls\n' }],
        ['patch', '/api/terminals/kid', { label: 'renamed' }],
      ];
      for (const who of ['wA', 'coordA', 'rr']) {
        for (const [method, url, body] of calls) {
          const res = await (request(app) as any)[method](url).set(as(who)).send(body);
          code(res, 403, 'owner_only');
        }
      }
      expect(terminalsDb.getById(db, 'kid')!.label).toBe('kid');
    });
  });
});
