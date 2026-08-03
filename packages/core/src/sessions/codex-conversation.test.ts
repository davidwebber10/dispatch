import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { SessionService } from './service.js';

/**
 * getConversation used to refuse every thread that was not claude-code, which left a Codex
 * thread in Pretty with no pageable history at all: the endpoint answered
 * `{ items: [], hasMore: false, unsupported: true }` and the Load-earlier button sat there
 * doing nothing. Codex keeps its own transcript under ~/.codex/sessions/<Y>/<M>/<D>/
 * rollout-<ts>-<sessionId>.jsonl, in its own format. These cover reading and paging it.
 */
const fakePty = { isAlive: () => false, kill: () => {} } as any;
const WORKDIR = '/proj/acme';
const CODEX_SESSION = '019fb678-d13c-7d02-b46d-9d0c2533649f';

let tmp: string;
let home: string;
let db: Database.Database;

const rolloutDir = () => path.join(home, '.codex', 'sessions', '2026', '07', '31');

const userLine = (text: string) => JSON.stringify({
  timestamp: '2026-07-31T04:40:30.231Z', type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});
const assistantLine = (text: string) => JSON.stringify({
  timestamp: '2026-07-31T04:40:33.771Z', type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
});
// The UI-event family, which duplicates response_item and must never be read.
const eventLine = (text: string) => JSON.stringify({
  timestamp: '2026-07-31T04:40:33.771Z', type: 'event_msg',
  payload: { type: 'agent_message', message: text },
});

/** Rollout files are newline-terminated; getConversation drops the trailing partial line. */
function writeRollout(lines: string[]) {
  fs.mkdirSync(rolloutDir(), { recursive: true });
  const name = `rollout-2026-07-31T00-39-59-${CODEX_SESSION}.jsonl`;
  fs.writeFileSync(path.join(rolloutDir(), name), lines.join('\n') + '\n');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-codex-conv-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  db = createDatabase(path.join(tmp, 'test.db'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  try { db.close(); } catch { /* noop */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

// `null` means the thread never captured a session id. Note it cannot be `undefined`:
// passing undefined to a defaulted parameter selects the default.
function codexThread(externalId: string | null = CODEX_SESSION): { svc: SessionService; terminalId: string } {
  sessionsDb.create(db, { id: 's1', provider: 'codex', name: 'acme', workingDir: WORKDIR });
  terminalsDb.create(db, { id: 'cx', sessionId: 's1', type: 'codex', label: 'Cell level data' });
  if (externalId) terminalsDb.updateExternalId(db, 'cx', externalId);
  const svc = new SessionService(db, fakePty, path.join(tmp, 'mcp.json'));
  return { svc, terminalId: 'cx' };
}

describe('getConversation for a Codex thread', () => {
  it('reads the rollout file instead of refusing as unsupported', () => {
    writeRollout([userLine('hello'), assistantLine('hi back')]);
    const { svc, terminalId } = codexThread();

    const conv = svc.getConversation(terminalId, { limit: 100 });

    expect(conv.unsupported).toBeUndefined();
    expect(conv.items.map((i) => [i.kind, i.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'hi back'],
    ]);
  });

  it('never renders the event_msg family, which duplicates response_item', () => {
    writeRollout([assistantLine('only once'), eventLine('only once')]);
    const { svc, terminalId } = codexThread();

    const conv = svc.getConversation(terminalId, { limit: 100 });

    expect(conv.items).toHaveLength(1);
    expect(conv.items[0]).toMatchObject({ kind: 'assistant', text: 'only once' });
  });

  it('windows to the newest `limit` lines and reports where the window starts', () => {
    writeRollout(Array.from({ length: 10 }, (_, i) => userLine(`m${i}`)));
    const { svc, terminalId } = codexThread();

    const conv = svc.getConversation(terminalId, { limit: 4 });

    expect(conv.items.map((i) => i.text)).toEqual(['m6', 'm7', 'm8', 'm9']);
    expect(conv.startLine).toBe(6);
    expect(conv.hasMore).toBe(true);
  });

  // The paging contract the client depends on: page N+1 asks for `before: startLine` of
  // page N, and the two windows must abut exactly — no line repeated, none skipped.
  it('pages older windows that tile exactly against the previous page', () => {
    writeRollout(Array.from({ length: 10 }, (_, i) => userLine(`m${i}`)));
    const { svc, terminalId } = codexThread();

    const first = svc.getConversation(terminalId, { limit: 4 });
    const second = svc.getConversation(terminalId, { before: first.startLine, limit: 4 });
    const third = svc.getConversation(terminalId, { before: second.startLine, limit: 4 });

    expect(second.items.map((i) => i.text)).toEqual(['m2', 'm3', 'm4', 'm5']);
    expect(third.items.map((i) => i.text)).toEqual(['m0', 'm1']);
    expect(third.startLine).toBe(0);
    expect(third.hasMore).toBe(false);
    // Concatenated back-to-front, the pages reconstruct the file exactly once.
    const all = [...third.items, ...second.items, ...first.items].map((i) => i.text);
    expect(all).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
  });

  it('carries the source line index so the client can anchor its next page', () => {
    writeRollout(Array.from({ length: 5 }, (_, i) => userLine(`m${i}`)));
    const { svc, terminalId } = codexThread();

    const conv = svc.getConversation(terminalId, { limit: 2 });

    expect(conv.items.map((i) => i.line)).toEqual([3, 4]);
  });

  it('returns empty (not unsupported) when the thread never captured a session id', () => {
    writeRollout([userLine('hello')]);
    const { svc, terminalId } = codexThread(null);

    const conv = svc.getConversation(terminalId, { limit: 100 });

    expect(conv.items).toEqual([]);
    expect(conv.unsupported).toBeUndefined();
  });

  it('returns empty when no rollout file exists for the session yet', () => {
    const { svc, terminalId } = codexThread();

    const conv = svc.getConversation(terminalId, { limit: 100 });

    expect(conv.items).toEqual([]);
    expect(conv.hasMore).toBe(false);
  });
});

describe('getConversation still refuses a thread with no transcript', () => {
  it('reports a shell thread as unsupported', () => {
    sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'acme', workingDir: WORKDIR });
    terminalsDb.create(db, { id: 'sh', sessionId: 's2', type: 'shell', label: 'zsh' });
    const svc = new SessionService(db, fakePty, path.join(tmp, 'mcp.json'));

    expect(svc.getConversation('sh', { limit: 10 })).toMatchObject({ items: [], unsupported: true });
  });
});
