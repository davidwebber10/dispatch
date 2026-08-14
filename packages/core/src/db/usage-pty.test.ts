import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from './schema.js';
import * as ptyDb from './usage-pty.js';

const S = {
  terminal_id: 'term1', transcript_path: '/tmp/a.jsonl', byte_offset: 128,
  last_total_input: 0, last_total_output: 0, last_total_cached: 0,
  updated_at: '2026-08-14T10:00:00.000Z',
};

describe('usage_pty_state', () => {
  let d: Database.Database;
  beforeEach(() => { d = new Database(':memory:'); initSchema(d); });

  it('round-trips state and replaces on a second put', () => {
    ptyDb.putState(d, S);
    expect(ptyDb.getState(d, 'term1')!.byte_offset).toBe(128);
    ptyDb.putState(d, { ...S, byte_offset: 512 });
    expect(ptyDb.getState(d, 'term1')!.byte_offset).toBe(512);
    const n = (d.prepare('SELECT COUNT(*) AS n FROM usage_pty_state').get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('returns null for a thread it has never seen', () => {
    expect(ptyDb.getState(d, 'nope')).toBeNull();
  });

  // The atomicity guard. If the row lands but the state does not, the next turn
  // re-reads the same range and double-counts.
  it('recordTurn writes the row and the state together, or neither', () => {
    ptyDb.recordTurn(d, {
      id: 'turn1', terminalId: 'term1', projectId: 'p1', provider: 'claude-code',
      model: 'claude-opus-5', role: '', startedAt: '2026-08-14T10:00:00.000Z',
      endedAt: '2026-08-14T10:00:30.000Z', outcome: 'idle',
      input: 10, output: 20, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: false,
    }, { ...S, byte_offset: 900 });

    expect((d.prepare('SELECT COUNT(*) AS n FROM usage_turns').get() as { n: number }).n).toBe(1);
    expect(ptyDb.getState(d, 'term1')!.byte_offset).toBe(900);
  });

  it('recordTurn rolls back the row when the state write fails', () => {
    d.exec('DROP TABLE usage_pty_state');
    expect(() => ptyDb.recordTurn(d, {
      id: 'turn2', terminalId: 'term1', projectId: 'p1', provider: 'claude-code',
      model: '', role: '', startedAt: '2026-08-14T10:00:00.000Z',
      endedAt: '2026-08-14T10:00:30.000Z', outcome: 'idle',
      input: 1, output: 1, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: false,
    }, S)).toThrow();
    expect((d.prepare('SELECT COUNT(*) AS n FROM usage_turns').get() as { n: number }).n).toBe(0);
  });
});
