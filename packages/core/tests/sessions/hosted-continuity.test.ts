// Continuity on a hosted box (2026-11-11): ordinary chat threads resume after a restart, a thread waiting on
// a gated tool is re-asked, Grok/OpenCode get the Continue stamp, and a replaced process is never `error`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { BootRecovery, CHAT_CONTINUE_PROMPT } from '../../src/sessions/boot-recovery.js';
import { ThreadConfigStore } from '../../src/sessions/thread-config.js';
import { settleRestartedThreads, RESTART_ACTIVITY, INTERRUPTED_ACTIVITY } from '../../src/os/continuity.js';

function setup() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  const add = (id: string, type: string, status: string, config: Record<string, unknown>) => {
    terminalsDb.create(db, { id, sessionId: 's1', type, label: id, config });
    db.prepare('UPDATE terminals SET status = ? WHERE id = ?').run(status, id);
  };
  return { db, add };
}

describe('hosted continuity', () => {
  const saved = { ...process.env };
  beforeEach(() => { process.env.DISPATCH_RESUME_CHATS = '1'; });
  afterEach(() => { process.env = { ...saved }; });

  it('shutdown keeps working chats + gated-tool waits for the kickstart, and stamps Grok/OpenCode for Continue', () => {
    const { db, add } = setup();
    add('chat', 'claude-code', 'working', { transport: 'structured' });
    add('gated', 'codex', 'needs_input', { transport: 'structured' });
    add('question', 'claude-code', 'needs_input', { transport: 'structured' });
    db.prepare("INSERT INTO pending_questions (terminal_id, request_id, payload, created_at) VALUES ('question','r','{}','2026-11-11')").run();
    add('grok', 'grok', 'working', { transport: 'structured' });
    add('run', 'claude-code', 'working', { transport: 'structured', runner: true });
    const store = new ThreadConfigStore(db);
    const br = new BootRecovery({ db, configStore: store, threads: { structuredManagerFor: () => ({}) as any, sendStructuredMessage: () => {} } });
    const out = br.shutdownPreservingInterruptedTurns(() => {
      db.prepare("UPDATE terminals SET status = 'waiting'").run(); // the kills settle every row
    });
    expect(out.sort()).toEqual(['chat', 'gated']);
    const cfg = (id: string) => JSON.parse(terminalsDb.getById(db, id)!.config || '{}');
    expect(typeof cfg('chat').interruptedAt).toBe('string');
    expect(typeof cfg('grok').interruptedAt).toBe('string');
    expect(cfg('question').interruptedAt).toBeUndefined();
    expect(cfg('run').interruptedAt).toBeUndefined();
    expect(terminalsDb.getById(db, 'chat')!.status).toBe('working');
  });

  it('the kickstart resumes a plain chat with the chat prompt; without the hosted switch it does not', async () => {
    const { db, add } = setup();
    add('chat', 'claude-code', 'working', { transport: 'structured' });
    const sent: Array<[string, string]> = [];
    const br = new BootRecovery({ db, configStore: new ThreadConfigStore(db), threads: { structuredManagerFor: () => ({}) as any, sendStructuredMessage: (id, t) => { sent.push([id, t]); } } });
    expect((await br.kickstartInterruptedAgents(0)).kicked).toEqual(['chat']);
    expect(sent).toEqual([['chat', CHAT_CONTINUE_PROMPT]]);

    process.env.DISPATCH_RESUME_CHATS = '0';
    const b = setup();
    b.add('chat', 'claude-code', 'working', { transport: 'structured' });
    const br2 = new BootRecovery({ db: b.db, configStore: new ThreadConfigStore(b.db), threads: { structuredManagerFor: () => ({}) as any, sendStructuredMessage: vi.fn() } });
    expect((await br2.kickstartInterruptedAgents(0)).kicked).toEqual([]);
  });

  it('a thread whose process the restart replaced is settled idle, never error', () => {
    const { db, add } = setup();
    add('shell', 'shell', 'working', {});
    add('grok', 'grok', 'working', { transport: 'structured', interruptedAt: '2026-11-11T00:00:00Z' });
    add('alive', 'claude-code', 'working', { transport: 'structured' });
    const marks: Array<[string, string]> = [];
    const out = settleRestartedThreads(db, (id) => id === 'alive', (id, a) => marks.push([id, a]));
    expect(out.sort()).toEqual(['grok', 'shell']);
    expect(marks).toContainEqual(['shell', RESTART_ACTIVITY]);
    expect(marks).toContainEqual(['grok', INTERRUPTED_ACTIVITY]);
  });
});
