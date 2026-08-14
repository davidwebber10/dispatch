import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as usageDb from '../db/usage.js';
import { closeInterruptedTurns } from './recorder.js';

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
