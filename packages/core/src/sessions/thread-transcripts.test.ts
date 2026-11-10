import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { ThreadTranscripts, pickRecoverableSession } from './thread-transcripts.js';
import { threadHarnessCapabilities } from './harness-capabilities.js';

// ThreadTranscripts alone: built on a database, with no SessionService.
const WORKDIR = '/proj/transcripts';
let tmp: string;
let home: string;
let db: Database.Database;
let transcripts: ThreadTranscripts;

const projectsDir = () => path.join(home, '.claude', 'projects', WORKDIR.replace(/\//g, '-'));
const userLine = (text: string, uuid: string) =>
  JSON.stringify({ type: 'user', uuid, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } });
const write = (id: string, lines: string[]) => fs.writeFileSync(path.join(projectsDir(), `${id}.jsonl`), lines.join('\n') + '\n');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-transcripts-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(projectsDir(), { recursive: true });
  db = createDatabase(path.join(tmp, 'test.db'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: WORKDIR });
  transcripts = new ThreadTranscripts(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  try { db.close(); } catch { /* noop */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('ThreadTranscripts', () => {
  it('locates a Claude Code transcript by the stored session id and pages it', async () => {
    terminalsDb.create(db, { id: 't', sessionId: 's1', type: 'claude-code', label: 't', externalId: 'sess' });
    write('sess', [userLine('one', 'u1'), userLine('two', 'u2')]);
    const located = transcripts.locateTranscript('t');
    expect(located && located !== 'unsupported' && located.file).toBe(path.join(projectsDir(), 'sess.jsonl'));
    const page = await transcripts.getConversation('t', { limit: 1 });
    expect(page.items.map((i: any) => i.text)).toEqual(['two']);
    expect(transcripts.conversationTail('t', 5).map((i: any) => i.text)).toEqual(['one', 'two']);
  });

  it('a type with no transcript is unsupported; a missing thread has none', () => {
    terminalsDb.create(db, { id: 'sh', sessionId: 's1', type: 'shell', label: 'sh' });
    expect(transcripts.locateTranscript('sh')).toBe('unsupported');
    expect(transcripts.locateTranscript('missing')).toBeNull();
  });

  it('recovers the session id of a thread only from one transcript born after the thread', () => {
    terminalsDb.create(db, { id: 't', sessionId: 's1', type: 'claude-code', label: 't' });
    write('only', [userLine('mine', 'u1')]);
    expect(transcripts.recoverSessionId('t', projectsDir())).toBe('only');
    expect(terminalsDb.getById(db, 't')!.external_id).toBe('only');
    write('second', [userLine('other', 'u2')]);
    terminalsDb.create(db, { id: 't2', sessionId: 's1', type: 'claude-code', label: 't2' });
    expect(transcripts.recoverSessionId('t2', projectsDir())).toBeNull(); // two files: ambiguous
    expect(transcripts.recoverSessionId('missing', projectsDir())).toBeNull();
    expect(transcripts.recoverSessionId('t2', path.join(tmp, 'no-such-dir'))).toBeNull();
  });

  it('pickRecoverableSession refuses a transcript born more than 60 s before the thread', () => {
    expect(pickRecoverableSession([{ id: 'a', birth: 1_000_000 }], 1_000_000 + 59_000)).toBe('a');
    expect(pickRecoverableSession([{ id: 'a', birth: 1_000_000 }], 1_000_000 + 61_000)).toBeNull();
    expect(pickRecoverableSession([], 0)).toBeNull();
  });

  it('search answers no match for a type without transcript search', async () => {
    terminalsDb.create(db, { id: 'cx', sessionId: 's1', type: 'codex', label: 'cx' });
    expect(await transcripts.searchConversation('cx', 'x')).toEqual({ matches: [] });
  });
});

describe('threadHarnessCapabilities', () => {
  it('names the transcript capabilities of each thread type', () => {
    expect(threadHarnessCapabilities('claude-code')).toEqual({ restHistory: false, restPageable: true, transcriptSearch: true });
    expect(threadHarnessCapabilities('codex')).toEqual({ restHistory: true, restPageable: true, transcriptSearch: false });
    for (const t of ['grok', 'opencode', 'shell', 'nope', undefined, null]) {
      expect(threadHarnessCapabilities(t)).toEqual({ restHistory: false, restPageable: false, transcriptSearch: false });
    }
  });
});
