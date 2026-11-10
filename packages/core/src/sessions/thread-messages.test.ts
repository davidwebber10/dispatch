// ThreadMessages alone: built from its typed inputs, with no SessionService.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as messagesDb from '../db/coordinator-messages.js';
import { ThreadMessages } from './thread-messages.js';

let db: Database.Database;
let live: Set<string>;
let sent: unknown[][];
let facadeSends: unknown[][];
let touched: unknown[][];
let lastSpawnError: Map<string, string>;
let msgs: ThreadMessages;

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/nowhere' });
  terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'c', config: { transport: 'structured', role: 'coordinator' } });
  terminalsDb.create(db, { id: 'sh', sessionId: 's1', type: 'shell', label: 'sh' });
  live = new Set();
  sent = []; facadeSends = []; touched = [];
  lastSpawnError = new Map();
  const manager = { isAlive: (id: string) => live.has(id), sendMessage: (...a: unknown[]) => { sent.push(a); } };
  msgs = new ThreadMessages({
    db, pty: { isAlive: () => false, write: () => {} } as any, clock: () => Date.parse('2026-11-09T12:00:00.000Z'),
    spawner: { lastSpawnError },
    threads: {
      structuredManagerForTerminal: () => manager as any,
      ensureStructuredAlive: () => false,
      isStructuredTerminal: (row) => row.id === 'coord',
      sendStructuredMessage: (...a) => { facadeSends.push(a); },
      noteThreadTouched: (...a) => { touched.push(a); },
    },
  });
});
afterEach(() => { db.close(); });

describe('ThreadMessages', () => {
  it('a live structured thread: sent, touched, and logged on the given clock', () => {
    live.add('coord');
    msgs.sendStructuredMessage('coord', 'hello', 'user');
    expect(sent).toEqual([['coord', 'hello', 'user']]);
    expect(touched).toEqual([['coord', 'user', undefined]]);
    expect(messagesDb.listForTerminal(db, 'coord').map((r) => [r.text, r.source, r.sentAt])).toEqual([['hello', 'user', '2026-11-09T12:00:00.000Z']]);
  });

  it('a thread that does not start: the error names the last spawn error', () => {
    lastSpawnError.set('coord', 'claude is not installed');
    expect(() => msgs.sendStructuredMessage('coord', 'x')).toThrow('could not start the thread: claude is not installed');
  });

  it('sendThreadMessage: a structured thread goes through the given facade send; a shell tab is refused', () => {
    expect(msgs.sendThreadMessage('coord', 'hi', 'coordinator').transport).toBe('structured');
    expect(facadeSends).toEqual([['coord', 'hi', 'coordinator', undefined]]);
    expect(() => msgs.sendThreadMessage('sh', 'ls')).toThrow('cannot message a shell tab');
    expect(() => msgs.sendThreadMessage('missing', 'x')).toThrow('Thread not found');
  });
});
