import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as usageDb from '../db/usage.js';
import * as appState from '../db/app-state.js';
import { closeInterruptedTurns } from './recorder.js';
import { createApp } from '../server.js';
import { TRACKING_KEY } from '../routes/analytics.js';

describe('closeInterruptedTurns', () => {
  it('closes rows left open by a dead daemon, with zero duration', () => {
    const d = new Database(':memory:');
    initSchema(d);
    usageDb.openTurn(d, {
      id: 't1', terminalId: 'term1', projectId: 'p', provider: 'claude-code',
      model: '', role: '', startedAt: '2026-08-13T10:00:00.000Z',
    });

    expect(closeInterruptedTurns(d)).toBe(1);

    const row = d.prepare('SELECT * FROM usage_turns').get() as usageDb.TurnRow;
    expect(row.outcome).toBe('interrupted');
    // ended_at equals started_at so the turn contributes no duration — otherwise a
    // restart would look like a turn that ran for hours.
    expect(row.ended_at).toBe('2026-08-13T10:00:00.000Z');
  });

  it('is a no-op when nothing is open', () => {
    const d = new Database(':memory:');
    initSchema(d);
    expect(closeInterruptedTurns(d)).toBe(0);
  });
});

/**
 * The import cutoff must be the instant recording BEGAN, not the instant someone
 * first opened the Analytics view. Stamped lazily on first read, a user who
 * upgrades and looks a week later stamps it a week late, and the importer then
 * re-imports the week the recorder already measured live — the token
 * double-count this project has shipped once before.
 */
describe('the boot path stamps the tracking cutoff', () => {
  it('writes analytics_tracking_started_at with no HTTP request made', () => {
    const d = new Database(':memory:');
    initSchema(d);
    expect(appState.get(d, TRACKING_KEY)).toBeNull();

    createApp({ db: d, skipPty: true });

    const stamped = appState.get(d, TRACKING_KEY);
    expect(stamped).toBeTruthy();
    // An ISO instant, not a placeholder.
    expect(Number.isFinite(Date.parse(stamped!))).toBe(true);
  });

  it('keeps the first value across later boots', () => {
    const d = new Database(':memory:');
    initSchema(d);
    appState.set(d, TRACKING_KEY, '2026-01-01T00:00:00.000Z');

    createApp({ db: d, skipPty: true });

    expect(appState.get(d, TRACKING_KEY)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('closes an interrupted turn on the same boot path', () => {
    const d = new Database(':memory:');
    initSchema(d);
    usageDb.openTurn(d, {
      id: 't1', terminalId: 'term1', projectId: 'p', provider: 'claude-code',
      model: '', role: '', startedAt: '2026-08-13T10:00:00.000Z',
    });

    createApp({ db: d, skipPty: true });

    const row = d.prepare('SELECT * FROM usage_turns').get() as usageDb.TurnRow;
    expect(row.outcome).toBe('interrupted');
  });

  /*
   * The history import is gone by decision: analytics is live recording from
   * the tracking start, and nothing else. An install that pressed the old
   * Import button still holds message-grain rows that would silently mix units
   * into every turn count forever — with the remove control gone too, boot is
   * the only place left that can honor the decision, so it sweeps them.
   */
  it('sweeps rows the removed history importer left behind', () => {
    const d = new Database(':memory:');
    initSchema(d);
    usageDb.insertClosed(d, {
      id: 'imported', terminalId: 'term1', projectId: 'p', provider: 'claude-code',
      model: 'claude-opus-5', role: '', startedAt: '2020-01-01T00:00:00.000Z',
      endedAt: '2020-01-01T00:00:00.000Z', outcome: 'idle',
      input: 5, output: 5, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: true,
    });
    usageDb.insertClosed(d, {
      id: 'measured', terminalId: 'term1', projectId: 'p', provider: 'claude-code',
      model: 'claude-opus-5', role: '', startedAt: '2026-08-13T10:00:00.000Z',
      endedAt: '2026-08-13T10:00:10.000Z', outcome: 'idle',
      input: 5, output: 5, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: false,
    });

    createApp({ db: d, skipPty: true });

    const ids = d.prepare('SELECT id FROM usage_turns').all() as { id: string }[];
    expect(ids.map((r) => r.id)).toEqual(['measured']);
  });
});
