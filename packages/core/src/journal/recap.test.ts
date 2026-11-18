import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { MessageJournal } from './journal.js';
import { journalRecap } from './recap.js';
import { failedInitServers } from '../os/hosted-mcp-policy.js';

const text = (type: 'user' | 'assistant', t: string) => ({ type, message: { role: type, content: [{ type: 'text', text: t }] } });

function setup() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
  terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 't' });
  return { db, journal: new MessageJournal(db) };
}

describe('journalRecap', () => {
  it('names the latest user and assistant messages and leaves out the one about to be sent again', () => {
    const { journal } = setup();
    journal.append('t1', { kind: 'user', payload: text('user', 'Find the Wellspring deliverable') });
    journal.append('t1', { kind: 'assistant', payload: text('assistant', 'It is due Friday.') });
    journal.append('t1', { kind: 'tool', payload: { type: 'assistant', message: { content: [{ type: 'tool_use' }] } } });
    journal.append('t1', { kind: 'user', payload: text('user', 'and the pending one') });
    const r = journalRecap(journal, 't1', ['and the pending one'])!;
    expect(r).toContain('User: Find the Wellspring deliverable');
    expect(r).toContain('Assistant: It is due Friday.');
    expect(r).not.toContain('pending one');
    expect(r).not.toMatch(/[–—]/);
  });
  it('is null when the journal has no conversation, and caps long turns', () => {
    const { journal } = setup();
    expect(journalRecap(journal, 't1')).toBeNull();
    journal.append('t1', { kind: 'user', payload: text('user', 'x'.repeat(5000)) });
    expect(journalRecap(journal, 't1')!.length).toBeLessThan(1000);
  });
});

describe('failedInitServers', () => {
  it('lists servers that failed or need sign-in, not connected or pending ones', () => {
    const ev = { mcp_servers: [{ name: 'a', status: 'connected' }, { name: 'monarch', status: 'failed' }, { name: 'c', status: 'needs-auth' }, { name: 'd', status: 'pending' }] };
    expect(failedInitServers(ev)).toEqual([{ name: 'monarch', status: 'failed' }, { name: 'c', status: 'needs-auth' }]);
    expect(failedInitServers({})).toEqual([]);
  });
});
