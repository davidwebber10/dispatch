import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../../src/db/connection.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';

// W3-B characterization: the transcript answers of the SessionService facade, recorded before the
// transcript code moved out of service.ts. The facade must answer the same after the move.
const fakePty = { isAlive: () => false, kill: () => {} } as any;
const WORKDIR = '/proj/seam';
let tmp: string;
let home: string;
let db: Database.Database;
let svc: SessionService;

const projectsDir = () => path.join(home, '.claude', 'projects', WORKDIR.replace(/\//g, '-'));
const userLine = (text: string, uuid: string) =>
  JSON.stringify({ type: 'user', uuid, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-seam-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(projectsDir(), { recursive: true });
  db = createDatabase(path.join(tmp, 'test.db'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'seam', workingDir: WORKDIR });
  terminalsDb.create(db, { id: 'cc', sessionId: 's1', type: 'claude-code', label: 'cc', externalId: 'sess-cc' });
  terminalsDb.create(db, { id: 'cx', sessionId: 's1', type: 'codex', label: 'cx' });
  terminalsDb.create(db, { id: 'gk', sessionId: 's1', type: 'grok', label: 'gk' });
  terminalsDb.create(db, { id: 'sh', sessionId: 's1', type: 'shell', label: 'sh' });
  fs.writeFileSync(path.join(projectsDir(), 'sess-cc.jsonl'), [userLine('alpha one', 'u1'), userLine('beta two', 'u2'), userLine('alpha three', 'u3')].join('\n') + '\n');
  svc = new SessionService(db, fakePty, path.join(tmp, 'mcp.json'));
});
afterEach(() => {
  vi.restoreAllMocks();
  try { db.close(); } catch { /* noop */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('SessionService transcript seam (characterization)', () => {
  it('history is owned by REST for a Codex thread only', () => {
    expect(['cc', 'cx', 'gk', 'sh', 'missing'].map((id) => svc.historyOwnedByRest(id))).toEqual([false, true, false, false, false]);
  });

  it('history can be paged over REST for Claude Code and Codex only', () => {
    expect(['cc', 'cx', 'gk', 'sh', 'missing'].map((id) => svc.historyRestPageable(id))).toEqual([true, true, false, false, false]);
  });

  it('a Claude Code thread pages its transcript by its stored session id', async () => {
    const page = await svc.getConversation('cc', { limit: 2 });
    expect(page.items.map((i: any) => i.text)).toEqual(['beta two', 'alpha three']);
    expect(page.cursor).toBe(3);
    expect(page.hasMore).toBe(true);
    expect(page.unsupported).toBeUndefined();
  });

  it('a thread type with no transcript says unsupported; a missing thread and a Codex thread with no session id are empty', async () => {
    expect((await svc.getConversation('sh')).unsupported).toBe(true);
    expect((await svc.getConversation('gk')).unsupported).toBe(true);
    const missing = await svc.getConversation('missing');
    expect(missing.items).toEqual([]);
    expect(missing.unsupported).toBeUndefined();
    const codex = await svc.getConversation('cx');
    expect(codex.items).toEqual([]);
    expect(codex.unsupported).toBeUndefined();
  });

  it('search covers Claude Code only: any other type answers no match and reads no file', async () => {
    const hit = await svc.searchConversation('cc', 'alpha');
    expect(hit.matches.length).toBe(2);
    expect(await svc.searchConversation('cx', 'alpha')).toEqual({ matches: [] });
    expect(await svc.searchConversation('sh', 'alpha')).toEqual({ matches: [] });
    expect(await svc.searchConversation('missing', 'alpha')).toEqual({ matches: [] });
  });

  it('the final output of a thread is read from the tail of the same transcript', () => {
    // No assistant text in the file: the answer is empty, not an error.
    expect(svc.finalOutput('cc')).toBe('');
    expect(svc.finalOutput('missing')).toBe('');
  });
});
