// Task 16: a thread key never lands in stored text, and old rows never leave the daemon with one.
// The tests read raw database rows and stored files, not only API answers.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createApp } from '../../src/server.js';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';
import { AgentService } from '../../src/agents/service.js';
import { EndlessService } from '../../src/endless/service.js';
import { EndlessStore } from '../../src/endless/store.js';
import { ViewKeeper } from '../../src/endless/view-keeper.js';
import { Compactor } from '../../src/endless/compactor.js';
import { appendLogged } from '../../src/endless/log.js';
import { KeyStreamRedactor, redactKeys } from '../../src/auth/redact-keys.js';
import { FakeSummarizer } from '../endless/fake-summarizer.js';
import { FakeManager } from '../endless/fake-manager.js';

const KEY = 'dtk_' + 'AbC-_9'.repeat(7) + 'Z'; // 4 + 43 characters
expect(KEY).toHaveLength(47);
const GONE = 'dtk_[redacted]';

class NoopPty extends PTYManager {
  override spawn(): number { return 1; }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(): boolean { return false; }
  override killAll(): void {}
}

/** Every text column of every table, as one string: the raw database. */
function dumpDb(db: Database.Database): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  const out: string[] = [];
  for (const { name } of tables) {
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) out.push(JSON.stringify(row));
  }
  return out.join('\n');
}

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptk-redact-')); root = fs.mkdtempSync(path.join(root, 'sb-')); });
afterEach(() => { fs.rmSync(path.dirname(root), { recursive: true, force: true }); });

describe('KeyStreamRedactor', () => {
  it('finds a key split at every offset and flushes the tail', () => {
    const text = `before ${KEY} after`;
    for (let cut = 1; cut < text.length; cut++) {
      const r = new KeyStreamRedactor();
      const out = r.push(text.slice(0, cut)) + r.push(text.slice(cut)) + r.end();
      expect(out).toBe(`before ${GONE} after`);
    }
  });
  it('holds back at most 46 characters and releases them at the end', () => {
    const r = new KeyStreamRedactor();
    const first = r.push('x'.repeat(100));
    expect(first).toHaveLength(54);
    expect(r.end()).toHaveLength(46);
  });
  it('keeps a surrogate pair whole', () => {
    const r = new KeyStreamRedactor();
    const text = 'a'.repeat(10) + '😀' + 'b'.repeat(45);
    expect(r.push(text) + r.end()).toBe(text);
  });
});

describe('scheduled runs', () => {
  function setup() {
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 'proj-1', provider: 'claude-code', name: 'p', workingDir: root });
    const sessionService: any = {
      createRunnerTerminal: vi.fn((sessionId, type, label, workingDir, prompt) => {
        terminalsDb.create(db, { id: 'term-1', sessionId, type, label, skipPermissions: true, workingDir, config: { runner: true, runnerPrompt: prompt } });
        return terminalsDb.rowToTerminal(terminalsDb.getById(db, 'term-1')!);
      }),
      stopTerminal: vi.fn(),
    };
    const broadcaster = { broadcast: vi.fn() };
    const runsDir = path.join(root, 'runs');
    const service = new AgentService(db, sessionService, broadcaster, runsDir);
    const schedule = service.createSchedule({
      projectId: 'proj-1', name: 'Run', provider: 'claude-code', workingDir: root, prompt: 'go', scheduleKind: 'one-shot',
      runAt: '2026-05-08T12:00:00.000Z', recurrenceRule: null, timezone: 'UTC', enabled: true, nextRunAt: null, defaultTerminalLabel: 'Run',
    });
    const run = service.runNow(schedule.id);
    return { db, service, run, runsDir, broadcaster };
  }
  const resultLine = (text: string, isError = false) =>
    JSON.stringify({ type: 'result', subtype: isError ? 'error' : 'success', is_error: isError, result: text, num_turns: 1 }) + '\n';

  it('stores no key in the transcript file, resultText or error when the key is split across chunks', () => {
    for (const isError of [false, true]) {
      const { db, service, run, runsDir, broadcaster } = setup.call(null);
      const line = resultLine(`env says ${KEY} done`, isError);
      const at = line.indexOf(KEY) + 20; // the middle of the key
      service.onRunnerData('term-1', Buffer.from(line.slice(0, at)));
      service.onRunnerData('term-1', Buffer.from(line.slice(at)));
      service.handleTerminalExit('term-1', 0); // flushes the held tail

      const file = fs.readFileSync(path.join(runsDir, `${run.id}.jsonl`), 'utf8');
      expect(file).not.toContain(KEY);
      expect(file).toContain(`env says ${GONE} done`);
      expect(file.endsWith('\n')).toBe(true); // the tail was flushed
      const raw = db.prepare('SELECT result_text, error FROM agent_runs WHERE id = ?').get(run.id) as { result_text: string | null; error: string | null };
      expect(JSON.stringify(raw)).not.toContain(KEY);
      expect(isError ? raw.error : raw.result_text).toContain(GONE);
      expect(dumpDb(db)).not.toContain(KEY);
      expect(JSON.stringify(broadcaster.broadcast.mock.calls)).not.toContain(KEY);
    }
  });

  it('flushes the tail when the run ends with no result line', () => {
    const { service, run, runsDir } = setup();
    service.onRunnerData('term-1', 'partial output with no newline ' + KEY.slice(0, 30));
    service.handleTerminalExit('term-1', 1);
    const file = fs.readFileSync(path.join(runsDir, `${run.id}.jsonl`), 'utf8');
    expect(file).toBe('partial output with no newline ' + KEY.slice(0, 30));
  });
});

describe('Chat store', () => {
  it('appendLogged stores no key in the rows', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const store = new EndlessStore(db);
    const views = new ViewKeeper(store);
    const compactor = new Compactor({ store, views, summarizer: new FakeSummarizer(), systemPrompt: () => 'SYS', projectName: () => null });
    appendLogged({ store, views, compactor }, { kind: 'work', text: `tool result: ${KEY}`, ref: 't1' });
    const rows = db.prepare('SELECT text FROM endless_messages').all() as { text: string }[];
    expect(rows.map((r) => r.text)).toEqual([`tool result: ${GONE}`]);
    expect(dumpDb(db)).not.toContain(KEY);
  });
});

describe('thread notes in the database', () => {
  function makeSvc() {
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: root });
    terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'CP', config: { transport: 'structured', role: 'coordinator' } });
    terminalsDb.create(db, { id: 'w1', sessionId: 's1', type: 'claude-code', label: 'worker', config: { transport: 'structured', role: 'agent', agentType: 'implementer' } });
    const svc = new SessionService(db, new NoopPty(), path.join(root, 'mcp.json'));
    const sent: string[] = [];
    const live = new Set(['coord', 'w1']);
    svc.setStructuredManager({
      on() {}, setDefaultEnv() {}, spawn: () => 1, isAlive: (id: string) => live.has(id),
      sendMessage: (_id: string, content: unknown) => { sent.push(typeof content === 'string' ? content : JSON.stringify(content)); },
      getPending: () => null, getSessionId: () => undefined, getEvents: () => [
        { type: 'assistant', message: { content: [{ type: 'text', text: `I ran env: ${KEY}` }] } },
      ], getEventsTail: () => [], getTurnTexts: () => [`last turn ${KEY}`], noteDeclaredStatus() {}, kill() {}, killAll() {},
    } as any);
    return { db, svc, sent };
  }

  it('noteTurnOutcome stores no key in lastOutcome', () => {
    const { db, svc } = makeSvc();
    svc.noteTurnOutcome('w1', { summary: `done ${KEY}`, needsHelp: true, inferred: false, state: 'blocked', blocker: `stuck on ${KEY}` });
    const cfg = JSON.parse((db.prepare('SELECT config FROM terminals WHERE id = ?').get('w1') as { config: string }).config);
    expect(cfg.lastOutcome.summary).toBe(`done ${GONE}`);
    expect(cfg.lastOutcome.blocker).toBe(`stuck on ${GONE}`);
    expect(dumpDb(db)).not.toContain(KEY);
  });

  it('reportStatus stores no key in the pending declaration', () => {
    const { db, svc } = makeSvc();
    // w1 is not alive in the manager for this call, so the declaration lands in the row.
    const dead = new SessionService(db, new NoopPty(), path.join(root, 'mcp2.json'));
    dead.reportStatus('w1', { state: 'blocked', summary: `s ${KEY}`, ask: `a ${KEY}`, blocker: `b ${KEY}` } as any);
    expect(dumpDb(db)).not.toContain(KEY);
    expect(dumpDb(db)).toContain(GONE);
    void svc;
  });

  it('reportStatus redacts the declaration before it reaches a live manager', () => {
    const { svc } = makeSvc();
    const seen: unknown[] = [];
    (svc as any).structuredManagerForTerminal = () => ({ isAlive: () => true, noteDeclaredStatus: (_id: string, d: unknown) => seen.push(d) });
    svc.reportStatus('w1', { state: 'blocked', summary: `s ${KEY}`, ask: `a ${KEY}` } as any);
    expect(JSON.stringify(seen)).not.toContain(KEY);
  });

  it('logCoordinatorMessage stores no key in the message log', () => {
    const { db, svc } = makeSvc();
    svc.sendStructuredMessage('coord', `a peer pasted ${KEY}`, 'coordinator');
    const rows = db.prepare('SELECT text FROM coordinator_messages').all() as { text: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe(`a peer pasted ${GONE}`);
    expect(dumpDb(db)).not.toContain(KEY);
  });

  it('the completion, question and blocked notices carry no key', () => {
    const { svc, sent } = makeSvc();
    svc.noteAgentCompletion('w1');
    svc.noteAgentNeedsHelp('w1', `need help with ${KEY}`);
    svc.routeAgentQuestionToCoordinator('w1', { toolName: 'AskUserQuestion', questions: [{ header: `H ${KEY}`, question: `Q ${KEY}`, options: [`o ${KEY}`] }] });
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const n of sent) expect(n).not.toContain(KEY);
    expect(sent.join('\n')).toContain(GONE);
    expect(svc.finalOutput('w1')).not.toContain(KEY);
    expect(svc.lastAssistantTextPublic('w1')).not.toContain(KEY);
  });
});

describe('reads of rows stored before this release', () => {
  function makeEndless() {
    const db = new Database(':memory:');
    initSchema(db);
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'salsify', workingDir: root });
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix', config: { role: 'agent', origin: 'endless' } });
    const fake = new FakeManager();
    const outputs: Record<string, string> = { t1: `report body ${KEY}` };
    const svc = new EndlessService({
      db, broadcaster: { broadcast: () => {} }, manager: fake.asManager(), chatDir: path.join(root, 'chat'), home: path.join(root, 'home'),
      summarizer: new FakeSummarizer(), timeZone: 'UTC', turn: { waitMs: 50, graceMs: 10 }, finalOutput: (id) => outputs[id] ?? '',
    });
    svc.start(3999);
    return { db, svc, fake };
  }

  it('a thread report to Chat is stored without the key', async () => {
    const { db, svc } = makeEndless();
    svc.arm('t1');
    svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await new Promise<void>((r) => setImmediate(r));
    const rows = db.prepare("SELECT text FROM endless_messages WHERE kind = 'work'").all() as { text: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain(GONE);
    expect(dumpDb(db)).not.toContain(KEY);
    svc.stop();
  });

  it('page, search, zoom, date and the view hide a key in an old row', () => {
    const { db, svc } = makeEndless();
    const store = (svc as any).store as EndlessStore;
    const old = store.append({ kind: 'work', text: `old row ${KEY}`, project: 's1', ref: 't1', media: [] });
    expect(dumpDb(db)).toContain(KEY); // the old row really holds it
    const answers = [
      JSON.stringify(svc.page({ limit: 10, project: null })),
      JSON.stringify(svc.around(old.i, 10, null)),
      JSON.stringify(svc.search('old', null, 10)),
      JSON.stringify(svc.zoom(old.i, 1)),
      svc.date(old.i),
      JSON.stringify(svc.viewLines()),
    ];
    for (const a of answers) expect(a).not.toContain(KEY);
    expect(answers[0]).toContain(GONE);
    svc.stop();
  });

  it('the terminal row routes, the conversation route and its search hide a key', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const app = createApp({ db, skipPty: true });
    const created = await request(app).post('/api/sessions').send({ provider: 'claude-code', workingDir: root, name: 't' });
    const sid = created.body.id;
    const home = path.join(root, 'home');
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const wd = '/tmp/proj-redact';
      terminalsDb.create(db, { id: 'cc-1', sessionId: sid, type: 'claude-code', label: 'thread', skipPermissions: true, workingDir: wd, externalId: 'sess-r', config: { lastOutcome: { summary: `old ${KEY}` } } });
      const dir = path.join(home, '.claude', 'projects', wd.replace(/\//g, '-'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'sess-r.jsonl'),
        '{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u1"}\n' +
        `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"env: ${KEY}"}]},"uuid":"a1"}\n`);
      expect(dumpDb(db)).toContain(KEY);
      const one = await request(app).get('/api/terminals/cc-1').expect(200);
      const list = await request(app).get(`/api/sessions/${sid}/terminals`).expect(200);
      const conv = await request(app).get('/api/terminals/cc-1/conversation').expect(200);
      const search = await request(app).get('/api/terminals/cc-1/conversation/search?q=env').expect(200);
      for (const r of [one, list, conv, search]) expect(JSON.stringify(r.body)).not.toContain(KEY);
      expect(JSON.stringify(one.body)).toContain(GONE);
      expect(JSON.stringify(conv.body)).toContain(GONE);
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    }
  });
});

describe('redactKeys', () => {
  it('leaves other text alone', () => {
    expect(redactKeys('dtk_short and plain text')).toBe('dtk_short and plain text');
  });
});
