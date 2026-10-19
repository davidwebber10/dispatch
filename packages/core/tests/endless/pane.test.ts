import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { collectPaneThreads, startOfLocalDay, PANE_MAX_THREADS } from '../../src/endless/pane.js';

const NOW = Date.UTC(2026, 9, 19, 15, 45, 0); // 15:45 UTC
const TODAY = new Date(Date.UTC(2026, 9, 19, 9, 0, 0)).toISOString();
const YESTERDAY = new Date(Date.UTC(2026, 9, 18, 9, 0, 0)).toISOString();
let db: Database.Database;

function thread(id: string, o: { session?: string; type?: string; status?: string; config?: Record<string, unknown>; last?: string | null; label?: string; archived?: boolean } = {}) {
  terminalsDb.create(db, { id, sessionId: o.session ?? 's1', type: o.type ?? 'claude-code', label: o.label ?? id, config: o.config ?? {} });
  if (o.status) terminalsDb.updateStatus(db, id, o.status);
  db.prepare('UPDATE terminals SET last_activity_at = ? WHERE id = ?').run(o.last === undefined ? TODAY : o.last, id);
  if (o.archived) db.prepare('UPDATE terminals SET archived_at = ? WHERE id = ?').run(TODAY, id);
}
const run = (question = (_id: string) => '') => collectPaneThreads(db, { now: NOW, timeZone: 'UTC', question });

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'studio', workingDir: '/w/studio' });
  sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'rollup', workingDir: '/w/rollup' });
});

describe('collectPaneThreads', () => {
  it('local midnight in the daemon time zone', () => {
    expect(startOfLocalDay(NOW, 'UTC')).toBe(Date.UTC(2026, 9, 19, 0, 0, 0));
  });

  it('keeps active threads of any age and finished threads of today only', () => {
    thread('w', { status: 'working', last: YESTERDAY });
    thread('q', { status: 'queued', last: null });
    thread('done-today', { status: 'waiting', config: { role: 'agent' } });
    thread('done-old', { status: 'waiting', config: { role: 'agent' }, last: YESTERDAY });
    expect(run().threads.map((t) => t.id).sort()).toEqual(['done-today', 'q', 'w']);
  });

  it('leaves out archived threads, file tabs and the coordinator', () => {
    thread('arch', { status: 'working', archived: true });
    thread('file', { type: 'file', status: 'working' });
    thread('coord', { status: 'working', config: { role: 'coordinator' } });
    thread('keep', { status: 'working' });
    expect(run().threads.map((t) => t.id)).toEqual(['keep']);
  });

  it('maps the status; an idle worker is done, an idle owner thread is idle', () => {
    thread('a', { status: 'working' });
    thread('b', { status: 'needs_input' });
    thread('c', { status: 'error' });
    thread('d', { status: 'waiting', config: { role: 'agent' } });
    thread('e', { status: 'waiting', config: { origin: 'endless', role: 'agent' } });
    thread('f', { status: 'waiting' });
    const by = Object.fromEntries(run().threads.map((t) => [t.id, t.state]));
    expect(by).toEqual({ a: 'working', b: 'needs_you', c: 'error', d: 'done', e: 'done', f: 'idle' });
  });

  it('orders needs you, working, queued, error, done; newest first inside a group', () => {
    thread('w-old', { status: 'working', last: new Date(Date.UTC(2026, 9, 19, 8)).toISOString() });
    thread('w-new', { status: 'working', last: new Date(Date.UTC(2026, 9, 19, 10)).toISOString() });
    thread('n', { status: 'needs_input' });
    thread('d', { status: 'waiting', config: { role: 'agent' } });
    thread('q', { status: 'queued' });
    thread('e', { status: 'error' });
    expect(run().threads.map((t) => t.id)).toEqual(['n', 'w-new', 'w-old', 'q', 'e', 'd']);
  });

  it('who started it', () => {
    thread('coord', { config: { role: 'coordinator' } });
    thread('chatroot', { status: 'working', config: { role: 'agent', origin: 'endless' } });
    thread('peer', { status: 'working', label: 'Fix PR #2' });
    thread('t-chat', { status: 'working', config: { origin: 'endless', role: 'agent' } });
    thread('t-role', { status: 'working', config: { role: 'agent', roleRun: 'run-1' } });
    thread('t-ov', { status: 'working', config: { role: 'agent', spawnedBy: 'coord' } });
    thread('t-legacy', { status: 'working', config: { role: 'agent' } });
    thread('t-peer', { status: 'working', config: { role: 'agent', spawnedBy: 'peer' } });
    thread('t-chatkid', { status: 'working', config: { role: 'agent', spawnedBy: 'chatroot' } });
    thread('t-user', { status: 'working' });
    const by = Object.fromEntries(run().threads.map((t) => [t.id, [t.startedBy, t.via]]));
    expect(by['t-chat']).toEqual(['chat', null]);
    expect(by['t-role']).toEqual(['role', null]);
    expect(by['t-ov']).toEqual(['overseer', null]);
    expect(by['t-legacy']).toEqual(['overseer', null]);
    expect(by['t-peer']).toEqual(['thread', 'Fix PR #2']);
    expect(by['t-chatkid']).toEqual(['chat', 'chatroot']);
    expect(by['t-user']).toEqual(['user', null]);
  });

  it('fills the question for needs_you only, cut to 280 characters', () => {
    thread('n', { status: 'needs_input' });
    thread('w', { status: 'working' });
    const asked: string[] = [];
    const rows = run((id) => { asked.push(id); return 'x'.repeat(400); }).threads;
    expect(asked).toEqual(['n']);
    expect(rows.find((t) => t.id === 'n')!.question).toHaveLength(280);
    expect(rows.find((t) => t.id === 'w')!.question).toBeNull();
  });

  it('a failing question callback leaves the question empty', () => {
    thread('n', { status: 'needs_input' });
    expect(run(() => { throw new Error('boom'); }).threads[0].question).toBeNull();
  });

  it('caps the response and says so', () => {
    for (let k = 0; k < PANE_MAX_THREADS + 5; k++) thread(`t${k}`, { status: 'working' });
    const r = run();
    expect(r.threads).toHaveLength(PANE_MAX_THREADS);
    expect(r.truncated).toBe(true);
  });
});
