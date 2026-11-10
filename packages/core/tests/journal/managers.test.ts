// packages/core/tests/journal/managers.test.ts
// The three structured managers write the message journal (W3-D): a finished item once, no deltas.
// Each manager runs against its fake CLI; no model is called.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { MessageJournal } from '../../src/journal/journal.js';
import { JournalRecorder } from '../../src/journal/recorder.js';
import { StructuredSessionManager } from '../../src/structured/manager.js';
import { CodexStructuredSessionManager } from '../../src/structured/codex-manager.js';
import { AcpStructuredSessionManager } from '../../src/structured/acp-manager.js';
import type { IStructuredManager } from '../../src/structured/manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakes = path.join(here, '..', 'structured');
const kill: IStructuredManager[] = [];
afterEach(() => { for (const m of kill.splice(0)) m.killAll(); });

function journalFor<M extends IStructuredManager & { journal?: JournalRecorder }>(manager: M, db = new Database(':memory:')) {
  initSchema(db);
  const journal = new MessageJournal(db);
  manager.journal = new JournalRecorder(journal);
  kill.push(manager);
  return { db, journal, manager, rows: (id = 't1') => journal.page(id, { limit: 500 }).items };
}
const once = (m: IStructuredManager, event: string, id = 't1', ms = 8000) => new Promise<unknown[]>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), ms);
  const on = (eid: string, ...rest: unknown[]) => { if (eid === id) { clearTimeout(t); m.off(event, on); resolve(rest); } };
  m.on(event, on);
});
const text = (row: { payload: unknown }) => {
  const b = (row.payload as any)?.message?.content?.[0];
  return b?.text ?? b?.thinking ?? b?.content ?? b?.name ?? (row.payload as any)?.type;
};

describe('the Claude manager writes the journal', () => {
  it('a finished assistant message is journaled once; its deltas are not', async () => {
    const { manager, rows } = journalFor(new StructuredSessionManager());
    const live: any[] = [];
    manager.on('event', (_id: string, e: unknown) => live.push(e));
    manager.spawn('t1', { command: process.execPath, args: [path.join(fakes, 'fake-claude-stream.mjs')], workDir: process.cwd() });
    const idle = once(manager, 'idle');
    manager.sendMessage('t1', 'STREAM 2 40'); // two messages of 40 text deltas; the first has a tool call with its result
    await idle;
    expect(rows().map((r) => r.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant', 'result']);
    expect(rows().map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(JSON.stringify(rows())).not.toContain('content_block_delta');
    // The live events that finished an item carry its sequence; a delta carries none.
    expect(live.filter((e) => typeof e.seq === 'number').map((e) => [e.type, e.seq])).toEqual([
      ['user', 1], ['assistant', 2], ['assistant', 3], ['user', 4], ['assistant', 5], ['result', 6],
    ]);
    expect(live.filter((e) => e.type === 'stream_event').every((e) => e.seq === undefined)).toBe(true);
    // The ring holds the same events with the same sequences (an older client replays the ring).
    expect((manager.getEvents('t1') as any[]).filter((e) => typeof e.seq === 'number').map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a second turn goes on with the next sequence, and a model switch is a notice', async () => {
    const { manager, rows } = journalFor(new StructuredSessionManager());
    manager.spawn('t1', { command: process.execPath, args: [path.join(fakes, 'fake-claude-stream.mjs')], workDir: process.cwd() });
    for (const words of ['one', 'two']) { const idle = once(manager, 'idle'); manager.sendMessage('t1', words); await idle; }
    manager.postNotice('t1', 'That model is not available');
    expect(rows().map((r) => [r.seq, r.kind])).toEqual([[1, 'user'], [2, 'assistant'], [3, 'result'], [4, 'user'], [5, 'assistant'], [6, 'result'], [7, 'notice']]);
  });
});

describe('the Codex manager writes the journal', () => {
  it('a finished assistant message is journaled once; its deltas are not', async () => {
    const { manager, rows } = journalFor(new CodexStructuredSessionManager());
    const live: any[] = [];
    manager.on('event', (_id: string, e: unknown) => live.push(e));
    manager.spawn('t1', { command: process.execPath, args: [path.join(fakes, 'fake-codex-app-server.mjs')], workDir: process.cwd() });
    const idle = once(manager, 'idle');
    manager.sendMessage('t1', 'stream please');
    await idle;
    expect(rows().map((r) => r.kind)).toEqual(['user', 'assistant', 'result']);
    expect(text(rows()[1])).toBe('Hello world');
    expect(JSON.stringify(rows())).not.toContain('content_block_delta');
    const stops = live.filter((e) => e.type === 'stream_event' && e.event?.type === 'content_block_stop');
    expect(stops.map((e) => e.seq)).toEqual([2]);
    expect(live.filter((e) => e.type === 'stream_event' && e.event?.type === 'content_block_delta').every((e) => e.seq === undefined)).toBe(true);
  });
});

describe('the ACP manager (Grok, OpenCode) writes the journal', () => {
  const spawn = (manager: AcpStructuredSessionManager, stateDir: string, extra: Record<string, unknown> = {}) =>
    manager.spawn('t1', { command: process.execPath, args: [path.join(fakes, 'fake-acp-agent.mjs')], workDir: os.tmpdir(), env: { FAKE_ACP_STATE_DIR: stateDir }, ...extra } as any);

  it('a finished assistant message is journaled once; its deltas are not', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3d-acp-'));
    const { manager, rows } = journalFor(new AcpStructuredSessionManager('grok'));
    spawn(manager, stateDir);
    const idle = once(manager, 'idle');
    manager.sendMessage('t1', 'TOOL hello');
    await idle;
    expect(rows().map((r) => [r.kind, text(r)])).toEqual([
      ['user', 'TOOL hello'], ['assistant', 'thinking about it'], ['tool', 'run_terminal_command'], ['tool', 'hello\n'], ['assistant', 'echo:hello'], ['result', 'result'],
    ]);
    expect(JSON.stringify(rows())).not.toContain('content_block_delta');
  });

  it('the history survives a new manager on the same database, and the replay of the agent adds nothing', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3d-acp-'));
    const first = journalFor(new AcpStructuredSessionManager('grok'));
    const session = once(first.manager, 'session');
    spawn(first.manager, stateDir);
    const [sessionId] = await session;
    for (const words of ['one', 'two']) { const idle = once(first.manager, 'idle'); first.manager.sendMessage('t1', words); await idle; }
    const before = first.rows();
    expect(before.map((r) => r.kind)).toEqual(['user', 'assistant', 'assistant', 'result', 'user', 'assistant', 'assistant', 'result']);
    first.manager.killAll();

    // The daemon starts again: a new manager and a new journal instance on the same database.
    const second = journalFor(new AcpStructuredSessionManager('grok'), first.db);
    spawn(second.manager, stateDir, { resumeId: sessionId });
    // The resumed session is ready when the manager added the settle after the agent's replay.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the resume did not finish')), 8000);
      const tick = () => ((second.manager.getEvents('t1') as any[]).some((e) => e?.subtype === 'backfill') ? (clearTimeout(t), resolve()) : setTimeout(tick, 10));
      tick();
    });
    expect(second.rows()).toEqual(before); // same items, same sequences
    const idle = once(second.manager, 'idle');
    second.manager.sendMessage('t1', 'three');
    await idle;
    expect(second.rows().map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('a thread from before the journal takes the replay of the agent once', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3d-acp-'));
    fs.writeFileSync(path.join(stateDir, 'fake-acp-old-session.json'), JSON.stringify([{ user: 'earlier question', agent: 'earlier answer' }]));
    const { manager, rows } = journalFor(new AcpStructuredSessionManager('grok'));
    spawn(manager, stateDir, { resumeId: 'old-session' });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the resume did not finish')), 8000);
      const tick = () => ((manager.getEvents('t1') as any[]).some((e) => e?.subtype === 'backfill') ? (clearTimeout(t), resolve()) : setTimeout(tick, 10));
      tick();
    });
    expect(rows().map((r) => [r.seq, r.kind, text(r)])).toEqual([[1, 'user', 'earlier question'], [2, 'assistant', 'earlier answer']]);
  });
});
