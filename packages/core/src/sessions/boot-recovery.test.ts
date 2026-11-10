// BootRecovery alone: built from its typed inputs, with no SessionService.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { ThreadConfigStore } from './thread-config.js';
import { BootRecovery } from './boot-recovery.js';

let db: Database.Database;
let sent: [string, string][];
let managers: Set<string>;
let failSend: Set<string>;
let recovery: BootRecovery;

function seed(id: string, config: Record<string, unknown>, opts: { type?: string; status?: string } = {}) {
  terminalsDb.create(db, { id, sessionId: 's1', type: opts.type ?? 'claude-code', label: id, workingDir: '/nowhere', config });
  terminalsDb.updateStatus(db, id, opts.status ?? 'working');
}
const cfg = (id: string) => JSON.parse(terminalsDb.getById(db, id)!.config || '{}');

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/nowhere' });
  sent = [];
  managers = new Set(['claude-code', 'codex']);
  failSend = new Set();
  recovery = new BootRecovery({
    db,
    configStore: new ThreadConfigStore(db),
    threads: {
      structuredManagerFor: (type) => (managers.has(type) ? ({} as any) : undefined),
      sendStructuredMessage: (id, content) => { if (failSend.has(id)) throw new Error('down'); sent.push([id, content]); },
    },
  });
});
afterEach(() => { db.close(); });

describe('BootRecovery', () => {
  it('kicks the working overseer threads of Claude and Codex through the given send and stamps kickedAt', async () => {
    seed('coord', { transport: 'structured', role: 'coordinator' });
    seed('cx', { transport: 'structured', role: 'agent' }, { type: 'codex' });
    seed('plain', { transport: 'structured' });
    seed('grok', { transport: 'structured', role: 'agent' }, { type: 'grok' });
    const r = await recovery.kickstartInterruptedAgents(0);
    expect(r.kicked.sort()).toEqual(['coord', 'cx']);
    expect(r.skipped).toEqual(['plain']); // Grok is never listed: it has no local record of the turn
    expect(sent.map(([id]) => id).sort()).toEqual(['coord', 'cx']);
    expect(sent[0][1]).toMatch(/^⚙️ Dispatch restarted and interrupted you mid-task/);
    expect(typeof cfg('coord').kickedAt).toBe('string');
  });

  it('a type with no manager is skipped; with no Claude and no Codex manager nothing is read', async () => {
    seed('cx', { transport: 'structured', role: 'agent' }, { type: 'codex' });
    managers.delete('codex');
    expect(await recovery.kickstartInterruptedAgents(0)).toEqual({ kicked: [], skipped: ['cx'], completed: [] });
    managers.clear();
    expect(await recovery.kickstartInterruptedAgents(0)).toEqual({ kicked: [], skipped: [], completed: [] });
  });

  it('a send that throws: skipped, no stamp; the interruptedAt stamp is consumed either way', async () => {
    seed('a', { transport: 'structured', role: 'agent', interruptedAt: '2026-11-09T00:00:00.000Z' });
    failSend.add('a');
    expect(await recovery.kickstartInterruptedAgents(0)).toEqual({ kicked: [], skipped: ['a'], completed: [] });
    expect(cfg('a')).toEqual({ transport: 'structured', role: 'agent' });
  });

  it('the shutdown restores working and stamps interruptedAt on the overseer threads that stopAll settled', () => {
    seed('coord', { transport: 'structured', role: 'coordinator', model: 'opus' });
    seed('plain', { transport: 'structured' });
    const restored = recovery.shutdownPreservingInterruptedTurns(() => {
      terminalsDb.updateStatus(db, 'coord', 'waiting');
      terminalsDb.updateStatus(db, 'plain', 'waiting');
    });
    expect(restored).toEqual(['coord']);
    expect(terminalsDb.getById(db, 'coord')!.status).toBe('working');
    expect(terminalsDb.getById(db, 'plain')!.status).toBe('waiting');
    expect(cfg('coord').model).toBe('opus'); // a patch of one key
    expect(typeof cfg('coord').interruptedAt).toBe('string');
  });

  it('a shutdown and the next boot: the interrupted thread is kicked once, and a third boot does not kick it again', async () => {
    seed('coord', { transport: 'structured', role: 'coordinator' });
    recovery.shutdownPreservingInterruptedTurns(() => terminalsDb.updateStatus(db, 'coord', 'waiting'));
    expect((await recovery.kickstartInterruptedAgents(0)).kicked).toEqual(['coord']);
    expect((await recovery.kickstartInterruptedAgents(0)).kicked).toEqual([]);
    expect(sent.length).toBe(1);
  });
});
