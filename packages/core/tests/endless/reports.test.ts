import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { EndlessService, UserError } from '../../src/endless/service.js';
import { reportText, recoveryOutcome, threadOrigin } from '../../src/endless/reports.js';
import { FakeSummarizer, settle } from './fake-summarizer.js';
import { FakeManager, texts } from './fake-manager.js';

let root: string;
let db: Database.Database;
let outputs: Record<string, string>;
const live: { svc: EndlessService; fake: FakeManager }[] = [];
const flush = () => new Promise<void>((r) => setImmediate(r));

function make() {
  const fake = new FakeManager();
  const svc = new EndlessService({
    db, broadcaster: { broadcast: () => {} }, manager: fake.asManager(),
    chatDir: path.join(root, 'chat'), home: path.join(root, 'home'), summarizer: new FakeSummarizer(),
    timeZone: 'UTC', turn: { waitMs: 50, graceMs: 10 }, finalOutput: (id) => outputs[id] ?? '',
  });
  svc.start(3999);
  live.push({ svc, fake });
  return { svc, fake };
}
// Read the table itself: each service keeps its own in-memory message count.
const works = () => db.prepare("SELECT i, text, project, ref FROM endless_messages WHERE kind = 'work' ORDER BY i").all() as { i: number; text: string; project: string | null; ref: string | null }[];
const rows = () => db.prepare('SELECT kind, text FROM endless_messages ORDER BY i').all() as { kind: string; text: string }[];
const endTurn = async (x: { svc: EndlessService; fake: FakeManager }) => {
  x.fake.emitEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
  x.fake.emitEvent({ type: 'result', subtype: 'success', is_error: false });
  await x.svc.turns.whenIdle();
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'endless-reports-'));
  db = new Database(':memory:');
  initSchema(db);
  outputs = {};
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'salsify', workingDir: path.join(root, 'salsify') });
  const chat = { role: 'agent', agentType: 'implementer', origin: 'endless', spawnDepth: 1 };
  terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Fix login', config: chat });
  terminalsDb.create(db, { id: 't3', sessionId: 's1', type: 'claude-code', label: 'Check docs', config: chat });
  terminalsDb.create(db, { id: 't2', sessionId: 's1', type: 'claude-code', label: 'Mine', config: { role: 'agent', agentType: 'implementer' } });
});
afterEach(async () => {
  for (const x of live.splice(0)) { x.svc.stop(); x.fake.killAll(); }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('report texts', () => {
  it('says what happened', () => {
    expect(reportText('Fix login', 'idle', ' Fixed. ')).toBe('[Fix login] report: Fixed.');
    expect(reportText('Fix login', 'needs_input', 'Which file?')).toBe('[Fix login] report: (waiting for an answer) Which file?');
    expect(reportText('Fix login', 'error', '')).toBe('[Fix login] report: (stopped with an error) (no output)');
    expect(reportText('Fix login', 'idle', '  ')).toBe('[Fix login] report: (no output)');
  });
  it('never clips a long report (the log splits it)', () => {
    const long = reportText('Fix login', 'idle', 'x'.repeat(50_000));
    expect(long).toBe(`[Fix login] report: ${'x'.repeat(50_000)}`);
    expect(long).not.toContain('characters clipped');
  });
  it('reads the origin marker from the thread config', () => {
    expect(threadOrigin({ config: JSON.stringify({ origin: 'endless' }) })).toBe('endless');
    expect(threadOrigin({ config: '{}' })).toBeNull();
    expect(threadOrigin({ config: null })).toBeNull();
    expect(threadOrigin({ config: 'not json' })).toBeNull();
  });
  it('recovery reports a settled or gone thread, and waits for a working one', () => {
    expect(recoveryOutcome(null)).toBe('gone');
    expect(recoveryOutcome({ status: 'waiting', archived_at: '2026-01-01' })).toBe('gone');
    expect(recoveryOutcome({ status: 'waiting', archived_at: null })).toBe('idle');
    expect(recoveryOutcome({ status: 'needs_input', archived_at: null })).toBe('needs_input');
    expect(recoveryOutcome({ status: 'error', archived_at: null })).toBe('error');
    for (const status of ['working', 'queued', 'scheduled']) expect(recoveryOutcome({ status, archived_at: null })).toBeNull();
  });
});

describe('thread reports', () => {
  it('arms only a thread Chat started', () => {
    const { svc } = make();
    expect(svc.arm('t1')).toEqual({ armed: true });
    expect(() => svc.arm('t2')).toThrow(UserError);
    expect(() => svc.arm('t2')).toThrow('not a Chat thread: t2');
    expect(() => svc.arm('nope')).toThrow('unknown thread: nope');
    expect(svc.store.hasPendingReport('t2')).toBe(false);
  });

  it('an armed thread that settles logs one work report and starts a turn with it', async () => {
    const x = make();
    outputs.t1 = 'Fixed the login cookie path.';
    x.svc.arm('t1');
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await flush();
    expect(works()).toEqual([expect.objectContaining({ text: '[Fix login] report: Fixed the login cookie path.', project: 's1', ref: 't1' })]);
    await settle();
    expect(x.fake.spawned).toHaveLength(1);
    expect(texts(x.fake.sent[0].content).at(-1)).toBe('work (salsify): [Fix login] report: Fixed the login cookie path.');
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' }); // a second edge: nothing is owed
    await flush();
    expect(works()).toHaveLength(1);
    await endTurn(x);
  });

  it('a thread Chat did not start, or did not arm, never reports', async () => {
    const x = make();
    outputs.t2 = 'mine';
    x.svc.onThreadSettled({ terminalId: 't2', threadStatus: 'idle' });
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await flush();
    expect(works()).toEqual([]);
    expect(x.fake.spawned).toHaveLength(0);
  });

  it('one ending claims every owed report and writes one report: arm, arm, settle → one report, owed 0', async () => {
    const x = make();
    outputs.t1 = 'jobs one and two';
    x.svc.arm('t1');
    x.svc.arm('t1'); // Chat sent job 2 mid-turn; the CLI folds it into the running turn
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await flush();
    expect(works().map((m) => m.text)).toEqual(['[Fix login] report: jobs one and two']);
    expect(x.svc.store.owedReports('t1')).toBe(0);
    // The next turn in that thread is the user's own: it never reports.
    outputs.t1 = 'the user asked something';
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await flush();
    expect(works()).toHaveLength(1);
    await settle();
    await endTurn(x);
  });

  it('arm, arm, crash (error edge) → one report, owed 0', async () => {
    const x = make();
    x.svc.arm('t1');
    x.svc.arm('t1');
    x.svc.onThreadStatus('t1', 'error');
    await flush();
    expect(works().map((m) => m.text)).toEqual(['[Fix login] report: (stopped with an error) (no output)']);
    expect(x.svc.store.owedReports('t1')).toBe(0);
    await settle();
    await endTurn(x);
  });

  it('arm, arm, settle, restart → recovery logs nothing', async () => {
    const a = make();
    outputs.t1 = 'done';
    a.svc.arm('t1');
    a.svc.arm('t1');
    a.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await flush();
    await settle();
    await endTurn(a);
    a.svc.stop();
    terminalsDb.updateStatus(db, 't1', 'waiting');
    const b = make();
    expect(works()).toHaveLength(1);
    expect(b.svc.store.hasPendingReport('t1')).toBe(false);
    expect(b.fake.spawned).toHaveLength(0);
  });

  it('delivers each report only after its claimed append has committed', async () => {
    const x = make();
    outputs.t1 = 'done';
    x.svc.arm('t1');
    const seen: { rows: number; owed: number; i: number }[] = [];
    vi.spyOn(x.svc.turns, 'deliver').mockImplementation((input) => {
      seen.push({ rows: works().length, owed: x.svc.store.owedReports('t1'), i: input.i });
    });
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await flush();
    expect(seen).toEqual([{ rows: 1, owed: 0, i: works()[0].i }]);
  });

  it('a long report is split into consecutive work messages and delivered once, whole', async () => {
    const x = make();
    outputs.t1 = 'y'.repeat(50_000);
    x.svc.arm('t1');
    const delivered: string[] = [];
    vi.spyOn(x.svc.turns, 'deliver').mockImplementation((input) => { delivered.push(input.text); });
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await flush();
    const w = works();
    expect(w.length).toBe(2);
    expect(w.every((m) => m.project === 's1' && m.ref === 't1')).toBe(true);
    expect(w.map((m) => m.text).join('')).toBe(`[Fix login] report: ${'y'.repeat(50_000)}`);
    expect(delivered).toEqual([`[Fix login] report: ${'y'.repeat(50_000)}`]);
  });

  it('a thread that ends with no output reports (no output)', async () => {
    const x = make();
    x.svc.arm('t1');
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await flush();
    expect(works().map((m) => m.text)).toEqual(['[Fix login] report: (no output)']);
    await settle();
    await endTurn(x);
  });

  it('a thread that stops on a question reports that it waits for an answer, and that consumes the report', async () => {
    const x = make();
    outputs.t1 = 'Which file should I change?';
    x.svc.arm('t1');
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'needs_input' });
    await flush();
    expect(works().map((m) => m.text)).toEqual(['[Fix login] report: (waiting for an answer) Which file should I change?']);
    expect(x.svc.store.hasPendingReport('t1')).toBe(false);
    await settle();
    await endTurn(x);
  });

  it('an armed thread that dies with no output reports that it stopped', async () => {
    const x = make();
    x.svc.arm('t1');
    x.svc.onThreadStatus('t1', 'error');
    await flush();
    expect(works().map((m) => m.text)).toEqual(['[Fix login] report: (stopped with an error) (no output)']);
    await settle();
    await endTurn(x);
  });

  it('one ending reports once, even when both hooks fire for it', async () => {
    const x = make();
    outputs.t1 = 'done';
    x.svc.arm('t1');
    x.svc.arm('t1');
    x.svc.arm('t1');
    // The settled listener and the error edge in the same tick: one ending (the settle text wins).
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    x.svc.onThreadStatus('t1', 'error');
    await flush();
    expect(works().map((m) => m.text)).toEqual(['[Fix login] report: done']);
    expect(x.svc.store.owedReports('t1')).toBe(0);
    // A repeated error edge (a hook error, then the process exit) is the same ending.
    x.svc.arm('t1'); // even if Chat armed again in between
    x.svc.onThreadStatus('t1', 'error');
    await flush();
    expect(works()).toHaveLength(1);
    // A new error edge after another status is a new ending.
    x.svc.onThreadStatus('t1', 'working');
    x.svc.onThreadStatus('t1', 'error');
    await flush();
    expect(works()).toHaveLength(2);
    expect(x.svc.store.owedReports('t1')).toBe(0);
    await settle();
    await endTurn(x);
  });

  it('the error-edge memory holds only threads that owe a report', async () => {
    const x = make();
    x.svc.onThreadStatus('t2', 'error');
    x.svc.onThreadStatus('t1', 'error');
    expect((x.svc as any).errored.size).toBe(0);
    x.svc.arm('t1');
    x.svc.onThreadStatus('t1', 'error');
    expect((x.svc as any).errored.size).toBe(1);
    x.svc.onThreadStatus('t1', 'idle');
    expect((x.svc as any).errored.size).toBe(0);
    await flush();
    await settle();
    await endTurn(x);
  });

  it('two threads that finish together make two reports and one turn', async () => {
    const x = make();
    outputs.t1 = 'one';
    outputs.t3 = 'two';
    x.svc.arm('t1');
    x.svc.arm('t3');
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    x.svc.onThreadSettled({ terminalId: 't3', threadStatus: 'idle' });
    await flush();
    await settle();
    expect(works().map((m) => m.text)).toEqual(['[Fix login] report: one', '[Check docs] report: two']);
    expect(x.fake.spawned).toHaveLength(1);
    expect(texts(x.fake.sent[1].content)).toEqual(['work (salsify): [Check docs] report: two']);
    await endTurn(x);
  });

  it('a report that races a user send: both are delivered, in log order', async () => {
    const x = make();
    outputs.t1 = 'done';
    x.svc.arm('t1');
    x.svc.send({ text: 'hello', project: null, images: [] }); // the turn waits for summaries
    x.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await flush();
    await settle();
    const logged = rows();
    expect(logged.map((r) => r.kind).sort()).toEqual(['user', 'work']);
    expect(x.fake.spawned).toHaveLength(1);
    // Each message reaches the turn once, in the order of the log.
    const line = (r: { kind: string; text: string }) => (r.kind === 'work' ? `work (salsify): ${r.text}` : `user: ${r.text}`);
    const sent = [texts(x.fake.sent[0].content).at(-1), ...x.fake.sent.slice(1).flatMap((s) => texts(s.content))];
    expect(sent).toEqual(logged.map(line));
    await endTurn(x);
  });

  it('a report logged before a restart is never logged again', async () => {
    const a = make();
    outputs.t1 = 'done';
    a.svc.arm('t1');
    a.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await flush();
    await settle();
    await endTurn(a);
    a.svc.stop();
    terminalsDb.updateStatus(db, 't1', 'waiting');
    const b = make(); // the restart: a new service over the same database
    b.svc.onThreadSettled({ terminalId: 't1', threadStatus: 'idle' });
    await flush();
    expect(works()).toHaveLength(1);
    expect(b.fake.spawned).toHaveLength(0);
  });

  it('a report lost to a restart is logged once at the next start, and only once', async () => {
    const a = make();
    outputs.t1 = 'done while the daemon was down';
    a.svc.arm('t1');
    a.svc.arm('t1'); // two jobs owed; the thread finished both while the daemon was down
    a.svc.stop(); // the settle edge never reached Chat
    terminalsDb.updateStatus(db, 't1', 'waiting');
    const b = make();
    expect(works().map((m) => m.text)).toEqual(['[Fix login] report: done while the daemon was down']);
    expect(b.svc.store.hasPendingReport('t1')).toBe(false);
    await settle();
    expect(b.fake.spawned).toHaveLength(1);
    await endTurn(b);
    b.svc.stop();
    make(); // a second restart
    expect(works()).toHaveLength(1);
  });

  it('recovery leaves a thread that is still working to its own settle edge', () => {
    const a = make();
    a.svc.arm('t1');
    a.svc.stop();
    terminalsDb.updateStatus(db, 't1', 'working');
    make();
    expect(works()).toEqual([]);
    expect(live[1].svc.store.hasPendingReport('t1')).toBe(true);
  });

  it('recovery reports a thread that is gone', async () => {
    const a = make();
    a.svc.arm('t1');
    a.svc.stop();
    db.prepare("UPDATE terminals SET archived_at = '2026-01-01' WHERE id = 't1'").run();
    const b = make();
    expect(works().map((m) => m.text)).toEqual(['[Fix login] report: (the thread is gone) (no output)']);
    await settle();
    await endTurn(b);
  });
});
