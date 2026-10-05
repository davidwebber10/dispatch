import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { computeBatchState, formatBatchFooter, isBusy } from '../../src/sessions/batch-state.js';

let db: Database.Database;

function agent(id: string, status: string, config: Record<string, unknown> = {}) {
  terminalsDb.create(db, { id, sessionId: 's1', type: 'claude-code', label: id.toUpperCase(), config: { role: 'agent', ...config } });
  terminalsDb.updateStatus(db, id, status);
}

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/tmp' });
});

describe('computeBatchState', () => {
  it('sorts agents into working, queued and waiting on the overseer', () => {
    agent('w', 'working');
    agent('s', 'scheduled');
    agent('q', 'queued');
    agent('n', 'needs_input');
    agent('p', 'working'); // working, but with a question pending to the overseer
    agent('i', 'waiting');
    agent('e', 'error');
    const state = computeBatchState(db, 's1', {}, (id) => id === 'p');
    expect(state.working.map((a) => a.id)).toEqual(['w', 's']);
    expect(state.queued.map((a) => a.id)).toEqual(['q']);
    expect(state.waiting.map((a) => a.id)).toEqual(['n', 'p']);
  });

  it('counts just-promoted dependents as working although they still read waiting', () => {
    agent('dep', 'waiting');
    expect(computeBatchState(db, 's1', { justStarted: ['dep'] }, () => false).working.map((a) => a.id)).toEqual(['dep']);
  });

  it('a pending question beats the just-started override: that agent waits on the overseer', () => {
    agent('dm', 'working');
    const state = computeBatchState(db, 's1', { justStarted: ['dm'] }, (id) => id === 'dm');
    expect(state).toEqual({ working: [], queued: [], waiting: [{ id: 'dm', label: 'DM' }] });
  });

  it('leaves out excluded ids, role runs, archived agents, the coordinator and plain threads', () => {
    agent('self', 'working');
    agent('role', 'working', { roleRun: 'nightly-check' });
    agent('gone', 'working');
    terminalsDb.archive(db, 'gone');
    terminalsDb.create(db, { id: 'coord', sessionId: 's1', type: 'claude-code', label: 'CP', config: { role: 'coordinator' } });
    terminalsDb.updateStatus(db, 'coord', 'working');
    terminalsDb.create(db, { id: 'plain', sessionId: 's1', type: 'claude-code', label: 'plain', config: {} });
    terminalsDb.updateStatus(db, 'plain', 'working');
    const state = computeBatchState(db, 's1', { exclude: ['self'] }, () => false);
    expect(state).toEqual({ working: [], queued: [], waiting: [] });
    expect(isBusy(state)).toBe(false);
  });
});

describe('formatBatchFooter — the spec texts, verbatim', () => {
  it('busy', () => {
    const state = { working: [{ id: 'b', label: 'Build X' }, { id: 'r', label: 'Review Y' }], queued: [{ id: 'q', label: 'Q' }], waiting: [] };
    expect(formatBatchFooter(state, [3, 7])).toBe(
      'Batch: still working — 2 agents ("Build X", "Review Y"); 1 queued.\n' +
      'Do not post a recap. If this needs a decision, add it with ledger_add\n' +
      'and post only that item. Otherwise write at most one line.\n' +
      'Open ledger items: N3, N7.',
    );
  });

  it('settled', () => {
    expect(formatBatchFooter({ working: [], queued: [], waiting: [] }, [3, 7])).toBe(
      'Batch: no other agent is working or queued.\n' +
      'If you start a next step now, write at most one line.\n' +
      'If you start nothing, the batch has settled: post the recap now\n' +
      '(ledger_list with forRecap, and list_agents).\n' +
      'Open ledger items: N3, N7.',
    );
  });

  it('names agents waiting on the overseer, and says "none" when no item is open', () => {
    const waiting = [{ id: 'p', label: 'Plan Z' }];
    expect(formatBatchFooter({ working: [{ id: 'b', label: 'Build X' }], queued: [], waiting }, []))
      .toBe('Batch: still working — 1 agent ("Build X"); 1 agent waiting on you ("Plan Z").\n' +
        'Do not post a recap. If this needs a decision, add it with ledger_add\n' +
        'and post only that item. Otherwise write at most one line.\n' +
        'Open ledger items: none.');
    expect(formatBatchFooter({ working: [], queued: [], waiting }, [])).toBe(
      'Batch: no other agent is working or queued.\n' +
      'Still 1 agent waiting on you ("Plan Z").\n' +
      'If you start a next step now, write at most one line.\n' +
      'If you start nothing, the batch has settled: post the recap now\n' +
      '(ledger_list with forRecap, and list_agents).\n' +
      'Open ledger items: none.');
  });
});
