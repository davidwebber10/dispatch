import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as messagesDb from '../../src/db/coordinator-messages.js';

describe('coordinator message log db', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initSchema(db); });

  it('appends rows and lists them oldest first, per terminal', () => {
    messagesDb.append(db, { terminalId: 'c1', source: 'user', text: 'second', sentAt: '2026-10-05T17:02:00.000Z' });
    messagesDb.append(db, { terminalId: 'c1', source: 'daemon', text: 'first', sentAt: '2026-10-05T17:01:00.000Z' });
    messagesDb.append(db, { terminalId: 'c2', source: 'user', text: 'other overseer', sentAt: '2026-10-05T17:00:00.000Z' });
    expect(messagesDb.listForTerminal(db, 'c1').map((m) => [m.text, m.source])).toEqual([['first', 'daemon'], ['second', 'user']]);
  });

  it('stores all four source values', () => {
    for (const source of ['user', 'canned', 'coordinator', 'daemon'] as const) {
      messagesDb.append(db, { terminalId: 'c1', source, text: source });
    }
    expect(messagesDb.listForTerminal(db, 'c1').map((m) => m.source).sort()).toEqual(['canned', 'coordinator', 'daemon', 'user']);
  });

  it('listUserMessages returns only user rows, and only those strictly after the given time', () => {
    messagesDb.append(db, { terminalId: 'c1', source: 'user', text: 'before', sentAt: '2026-10-05T17:00:00.000Z' });
    messagesDb.append(db, { terminalId: 'c1', source: 'user', text: 'at', sentAt: '2026-10-05T17:01:00.000Z' });
    messagesDb.append(db, { terminalId: 'c1', source: 'canned', text: 'card', sentAt: '2026-10-05T17:02:00.000Z' });
    messagesDb.append(db, { terminalId: 'c1', source: 'user', text: 'after', sentAt: '2026-10-05T17:03:00.000Z' });
    expect(messagesDb.listUserMessages(db, 'c1', null).map((m) => m.text)).toEqual(['before', 'at', 'after']);
    expect(messagesDb.listUserMessages(db, 'c1', '2026-10-05T17:01:00.000Z').map((m) => m.text)).toEqual(['after']);
  });

  it('messageText keeps a string, joins text blocks, and turns an image into [image]', () => {
    expect(messagesDb.messageText('hello')).toBe('hello');
    expect(messagesDb.messageText([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } } as any,
      { type: 'text', text: 'caption' },
      { type: 'text', text: 'line two' },
    ])).toBe('[image]\ncaption\nline two');
  });
});
