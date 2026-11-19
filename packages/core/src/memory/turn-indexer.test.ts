import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as store from '../db/memory.js';
import { parseClaudeTranscript } from '../conversation/transcript.js';
import { parseCodexRollout } from '../conversation/codex-transcript.js';
import { MessageJournal } from '../journal/journal.js';
import { MemoryService, projectsFromDb } from './service.js';
import { updateMemorySettings } from './settings.js';
import { TurnIndexer } from './turn-indexer.js';

const claudeLine = (role: 'user' | 'assistant', text: string, uuid: string) => JSON.stringify(role === 'user'
  ? { type: 'user', uuid, timestamp: '2026-11-19T10:00:00Z', message: { role: 'user', content: text } }
  : { type: 'assistant', uuid, timestamp: '2026-11-19T10:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const codexLine = (role: 'user' | 'assistant', text: string) => JSON.stringify({
  type: 'response_item', timestamp: '2026-11-19T10:00:00Z',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});
const toolLine = JSON.stringify({ type: 'assistant', uuid: 'tool1', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'cat secret-file-content' } }] } });

/** Memory layer 1 (spec 2026-11-17-memory-design.md, slice 1.4): the words of each thread, searchable, no model. */
describe('conversation index', () => {
  let db: Database.Database;
  let tmp: string;
  let memory: MemoryService;
  let indexer: TurnIndexer;
  let journal: MessageJournal;
  const files: Record<string, { file: string; parseLine: (l: string) => any[] }> = {};

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-turns-'));
    for (const id of ['A', 'B']) sessionsDb.create(db, { id, provider: 'claude-code', name: id, workingDir: tmp });
    terminalsDb.create(db, { id: 'claudeA', sessionId: 'A', type: 'claude-code', label: 'Claude in A' });
    terminalsDb.create(db, { id: 'codexA', sessionId: 'A', type: 'codex', label: 'Codex in A' });
    terminalsDb.create(db, { id: 'claudeB', sessionId: 'B', type: 'claude-code', label: 'Claude in B' });
    terminalsDb.create(db, { id: 'grokA', sessionId: 'A', type: 'grok', label: 'Grok in A' });
    files.claudeA = { file: path.join(tmp, 'a.jsonl'), parseLine: parseClaudeTranscript };
    files.codexA = { file: path.join(tmp, 'rollout.jsonl'), parseLine: parseCodexRollout };
    files.claudeB = { file: path.join(tmp, 'b.jsonl'), parseLine: parseClaudeTranscript };
    fs.writeFileSync(files.claudeA.file, [claudeLine('user', 'How do we deploy the billing service?', 'u1'), toolLine, claudeLine('assistant', 'Deploy it with the release workflow.', 'a1'), ''].join('\n'));
    fs.writeFileSync(files.codexA.file, [codexLine('user', 'Where is the deploy log kept?'), codexLine('assistant', 'In the logs folder.'), ''].join('\n'));
    fs.writeFileSync(files.claudeB.file, [claudeLine('user', 'Deploy notes for project B', 'b1'), ''].join('\n'));
    journal = new MessageJournal(db);
    journal.append('grokA', { kind: 'user', payload: { message: { content: 'Grok deploy question' } } } as any);
    memory = new MemoryService({ db, projects: () => projectsFromDb(db), onActive: () => { void indexer.catchUp(); } });
    updateMemorySettings(db, { enabled: true }); // off by default
    indexer = new TurnIndexer({ db, journal, locate: (id) => files[id] ?? null, active: () => memory.active(), skip: (id) => memory.keepsOut(id) });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('indexes the words of the person and the agent from Claude, Codex and the journal; no tool calls', async () => {
    await indexer.catchUp();
    const hits = memory.searchConversations('deploy', null, null);
    expect([...new Set(hits.map((h) => h.terminalId))].sort()).toEqual(['claudeA', 'claudeB', 'codexA', 'grokA']);
    expect(memory.searchConversations('secret', null, null)).toEqual([]);
    const a = memory.searchConversations('billing', null, null)[0];
    expect(a).toMatchObject({ terminalId: 'claudeA', sessionId: 'A', thread: 'Claude in A', role: 'user', ref: 'u1' });
  });

  it('a thread searches only its own project', async () => {
    await indexer.catchUp();
    const caller = { terminalId: 'codexA', sessionId: 'A', harness: 'codex' };
    expect(memory.searchConversations('deploy', caller, null).map((h) => h.sessionId)).not.toContain('B');
    expect(memory.searchConversations('deploy', null, 'B').map((h) => h.terminalId)).toEqual(['claudeB']);
  });

  it('reads only what is new, and waits for a line that is not finished', async () => {
    await indexer.catchUp();
    const before = store.getCursor(db, 'claudeA').fileOffset;
    expect(await indexer.indexThread('claudeA')).toBe(0);
    fs.appendFileSync(files.claudeA.file, claudeLine('user', 'Rollback steps please', 'u2') + '\n' + '{"type":"user","message":{"content":"half a li');
    expect(await indexer.indexThread('claudeA')).toBe(1);
    expect(store.getCursor(db, 'claudeA').fileOffset).toBeGreaterThan(before);
    fs.appendFileSync(files.claudeA.file, 'ne"},"uuid":"u3"}\n');
    expect(await indexer.indexThread('claudeA')).toBe(1);
    expect(memory.searchConversations('half', null, null)).toHaveLength(1);
    // A replaced (shorter) file is read from its start.
    fs.writeFileSync(files.claudeA.file, claudeLine('user', 'fresh start', 'u9') + '\n');
    expect(await indexer.indexThread('claudeA')).toBe(1);
  });

  it('off the record: read but not kept, and hidden from search; paused: not read at all', async () => {
    memory.setOffRecord('claudeA', true);
    await indexer.catchUp();
    expect(memory.searchConversations('billing', null, null)).toEqual([]);
    memory.setOffRecord('claudeA', false);
    await indexer.indexThread('claudeA');
    expect(memory.searchConversations('billing', null, null)).toEqual([]); // the words of that time stay out
    updateMemorySettings(db, { paused: true });
    fs.appendFileSync(files.codexA.file, codexLine('user', 'paused words') + '\n');
    await indexer.indexThread('codexA');
    expect(memory.searchConversations('paused', null, null)).toEqual([]);
    updateMemorySettings(db, { paused: false });
    await indexer.indexThread('codexA');
    expect(memory.searchConversations('paused', null, null)).toHaveLength(1);
  });

  it('a project that is not remembered keeps no words; a deleted thread takes its words with it', async () => {
    updateMemorySettings(db, { projectsOff: ['B'] });
    await indexer.catchUp();
    expect(memory.searchConversations('deploy', null, 'B')).toEqual([]);
    expect(memory.searchConversations('billing', null, null)).toHaveLength(1);
    db.prepare("DELETE FROM terminals WHERE id = 'claudeA'").run();
    expect(memory.searchConversations('billing', null, null)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_turns WHERE terminal_id = 'claudeA'").get()).toEqual({ n: 0 });
  });

  it('off (the default): no harness file is read; turning it on runs the catch-up once', async () => {
    memory.updateSettings({ enabled: false });
    await indexer.catchUp();
    indexer.schedule('claudeA');
    await indexer.idle();
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_turns').get()).toEqual({ n: 0 });
    expect(store.getCursor(db, 'claudeA').fileOffset).toBe(0);
    memory.updateSettings({ enabled: true }); // off -> on: onActive starts the catch-up
    await indexer.idle();
    expect([...new Set(memory.searchConversations('deploy', null, null).map((h) => h.terminalId))].sort()).toEqual(['claudeA', 'claudeB', 'codexA', 'grokA']);
  });

  it('schedule runs one thread at a time and idle() waits for the queue', async () => {
    indexer.schedule('claudeA');
    indexer.schedule('codexA');
    await indexer.idle();
    expect(memory.searchConversations('deploy', null, 'A').length).toBe(3);
  });
});
