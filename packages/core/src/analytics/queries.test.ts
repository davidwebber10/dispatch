// Day buckets are local time, so the assertions below only hold in a known zone.
// Set it before anything reads the clock; a test that passes only in one timezone
// is a defect, not a quirk.
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as usageDb from '../db/usage.js';
import { summary, series, top, records } from './queries.js';

function turn(d: Database.Database, o: Partial<usageDb.ClosedTurnInput> & { id: string; startedAt: string }) {
  usageDb.insertClosed(d, {
    terminalId: 'term1', projectId: 'proj1', provider: 'claude-code', model: 'claude-opus-5',
    role: 'agent', endedAt: o.startedAt, outcome: 'idle',
    input: 0, output: 0, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: false,
    ...o,
  } as usageDb.ClosedTurnInput);
}

describe('analytics queries', () => {
  let d: Database.Database;
  beforeEach(() => {
    d = new Database(':memory:');
    initSchema(d);
    turn(d, { id: 'a', startedAt: '2026-08-10T10:00:00.000Z', endedAt: '2026-08-10T10:00:30.000Z', input: 100, output: 50 });
    turn(d, { id: 'b', startedAt: '2026-08-10T22:00:00.000Z', endedAt: '2026-08-10T22:00:10.000Z', input: 10, output: 5, model: 'claude-sonnet-5' });
    turn(d, { id: 'c', startedAt: '2026-08-12T09:00:00.000Z', endedAt: '2026-08-12T09:01:00.000Z', input: 1, output: 2, projectId: 'proj2', terminalId: 'term2' });
  });

  /*
   * The importer writes one row per assistant MESSAGE, not one per turn — a
   * transcript records no turn boundaries. So after an import the TURNS figure
   * mixes two units, and the reader has to be told. The tokens stay in the totals
   * either way; only the COUNT is a different unit.
   */
  it('counts imported rows separately, with the same filters as everything else', () => {
    turn(d, {
      id: 'imported', startedAt: '2026-08-01T09:00:00.000Z', endedAt: '2026-08-01T09:00:00.000Z',
      input: 1000, output: 500, backfilled: true,
    });

    const s = summary(d, {});
    expect(s.turns).toBe(4);
    expect(s.backfilledTurns).toBe(1);
    // Imported tokens are real and stay in the totals.
    expect(s.inputTokens).toBe(1111);

    // Same filters as every other figure in the summary.
    expect(summary(d, { from: '2026-08-05T00:00:00.000Z' }).backfilledTurns).toBe(0);
    expect(summary(d, { projectId: 'proj2' }).backfilledTurns).toBe(0);
  });

  it('reports zero imported rows when nothing was imported', () => {
    expect(summary(d, {}).backfilledTurns).toBe(0);
  });

  it('summarises tokens, turns and threads', () => {
    const s = summary(d, {});
    expect(s.turns).toBe(3);
    expect(s.threads).toBe(2);
    expect(s.inputTokens).toBe(111);
    expect(s.outputTokens).toBe(57);
    expect(s.totalTokens).toBe(168);
  });

  // A turn that reported no usage at all is not a turn that used nothing. Codex can
  // settle through its error path with no tokenUsage frame, and a PTY thread emits
  // no frames at all. Those must be countable separately so the UI never shows them
  // as a measured zero.
  it('counts turns that reported no usage separately', () => {
    turn(d, { id: 'silent', startedAt: '2026-08-12T15:00:00.000Z', endedAt: '2026-08-12T15:00:05.000Z', messages: 0 });
    const s = summary(d, {});
    expect(s.turns).toBe(4);
    expect(s.unreportedTurns).toBe(1);
    expect(summary(d, { from: '2026-08-13T00:00:00.000Z' }).unreportedTurns).toBe(0);
  });

  it('filters by project and by date range', () => {
    expect(summary(d, { projectId: 'proj2' }).turns).toBe(1);
    expect(summary(d, { from: '2026-08-11T00:00:00.000Z' }).turns).toBe(1);
    expect(summary(d, { to: '2026-08-11T00:00:00.000Z' }).turns).toBe(2);
  });

  it('buckets a series by day and splits by model', () => {
    const pts = series(d, { metric: 'tokens', groupBy: 'model' });
    const day10 = pts.filter((p) => p.day === '2026-08-10');
    expect(day10.length).toBe(2);
    expect(day10.find((p) => p.key === 'claude-opus-5')!.value).toBe(150);
    expect(day10.find((p) => p.key === 'claude-sonnet-5')!.value).toBe(15);
  });

  it('counts turns per day when grouping is none', () => {
    const pts = series(d, { metric: 'turns', groupBy: 'none' });
    expect(pts.find((p) => p.day === '2026-08-10')!.value).toBe(2);
    expect(pts.find((p) => p.day === '2026-08-12')!.value).toBe(1);
  });

  it('excludes zero-duration rows from the duration metric', () => {
    turn(d, { id: 'z', startedAt: '2026-08-12T12:00:00.000Z', endedAt: '2026-08-12T12:00:00.000Z', outcome: 'interrupted' });
    const pts = series(d, { metric: 'duration', groupBy: 'none' });
    // 2026-08-12 has one real 60s turn; the interrupted row must not drag the mean to 30s
    expect(pts.find((p) => p.day === '2026-08-12')!.value).toBe(60);
  });

  it('ranks top projects by tokens', () => {
    const rows = top(d, { dimension: 'project' });
    expect(rows[0].key).toBe('proj1');
    expect(rows[0].value).toBe(165);
  });

  it('ranks top threads by tokens, labelled by the terminal label', () => {
    const rows = top(d, { dimension: 'thread' });
    expect(rows[0].key).toBe('term1');
    expect(rows[0].value).toBe(165);
  });

  // A model with no entry in pricing.ts must still have its tokens counted
  // normally in every total — analytics has no notion of a "priced" model.
  it('counts tokens from a model that has no price entry like any other model', () => {
    turn(d, {
      id: 'unpriced', startedAt: '2026-08-12T14:00:00.000Z', endedAt: '2026-08-12T14:00:10.000Z',
      model: 'some-future-model', input: 1_000_000, output: 0,
    });
    const s = summary(d, {});
    expect(s.inputTokens).toBe(1_000_111);
  });

  it('summary filtered by provider returns only that provider\'s turns', () => {
    turn(d, {
      id: 'codex1', startedAt: '2026-08-11T10:00:00.000Z', endedAt: '2026-08-11T10:00:20.000Z',
      provider: 'codex', model: 'gpt-5-codex', input: 20, output: 10,
    });
    const s = summary(d, { provider: 'codex' });
    expect(s.turns).toBe(1);
    expect(s.inputTokens).toBe(20);
    expect(s.outputTokens).toBe(10);
  });

  it('series filtered by provider only aggregates that provider\'s turns', () => {
    turn(d, {
      id: 'codex1', startedAt: '2026-08-11T10:00:00.000Z', endedAt: '2026-08-11T10:00:20.000Z',
      provider: 'codex', model: 'gpt-5-codex', input: 20, output: 10,
    });
    const pts = series(d, { provider: 'codex', metric: 'tokens', groupBy: 'none' });
    expect(pts.length).toBe(1);
    expect(pts[0].day).toBe('2026-08-11');
    expect(pts[0].value).toBe(30);
  });

  it('combines provider with project and date range, narrowing rather than overriding', () => {
    turn(d, {
      id: 'codex-proj1', startedAt: '2026-08-11T10:00:00.000Z', endedAt: '2026-08-11T10:00:20.000Z',
      provider: 'codex', projectId: 'proj1', input: 20, output: 10,
    });
    // Same provider, different project: must be excluded by the projectId filter.
    turn(d, {
      id: 'codex-proj2', startedAt: '2026-08-11T11:00:00.000Z', endedAt: '2026-08-11T11:00:20.000Z',
      provider: 'codex', projectId: 'proj2', input: 5, output: 5,
    });
    // Same provider and project, but outside the date range: must be excluded by the range filter.
    turn(d, {
      id: 'codex-proj1-late', startedAt: '2026-08-13T10:00:00.000Z', endedAt: '2026-08-13T10:00:20.000Z',
      provider: 'codex', projectId: 'proj1', input: 999, output: 999,
    });
    // Same project and inside the same date window, but a DIFFERENT provider: this row
    // is invisible to the projectId and date predicates, so only the provider predicate
    // can exclude it. Without this row the test would pass even if provider filtering
    // were deleted entirely, because projectId + date range alone already isolate the
    // 'codex-proj1' turn.
    turn(d, {
      id: 'claude-proj1-same-window', startedAt: '2026-08-11T12:00:00.000Z', endedAt: '2026-08-11T12:00:20.000Z',
      provider: 'claude-code', projectId: 'proj1', input: 500, output: 500,
    });
    const s = summary(d, {
      provider: 'codex', projectId: 'proj1',
      from: '2026-08-11T00:00:00.000Z', to: '2026-08-12T00:00:00.000Z',
    });
    expect(s.turns).toBe(1);
    expect(s.inputTokens).toBe(20);
    expect(s.outputTokens).toBe(10);
  });

  // Filtering to a provider whose turns never carried a usage frame (a PTY thread,
  // for instance) must surface those turns as unreported, not silently as a
  // measured zero.
  it('reports unreportedTurns when filtered to a provider whose usage was never reported', () => {
    turn(d, {
      id: 'pty1', startedAt: '2026-08-11T12:00:00.000Z', endedAt: '2026-08-11T12:00:05.000Z',
      provider: 'pty', model: '', messages: 0,
    });
    const s = summary(d, { provider: 'pty' });
    expect(s.turns).toBe(1);
    expect(s.unreportedTurns).toBe(1);
    expect(s.totalTokens).toBe(0);
  });

  it('returns zeroes for an unknown provider rather than throwing', () => {
    expect(() => summary(d, { provider: 'nonexistent-provider' })).not.toThrow();
    const s = summary(d, { provider: 'nonexistent-provider' });
    expect(s.turns).toBe(0);
    expect(s.totalTokens).toBe(0);
    expect(s.unreportedTurns).toBe(0);
  });

  it('reports all-time records', () => {
    const r = records(d);
    expect(r.totalTokens).toBe(168);
    expect(r.busiestDay).toBe('2026-08-10');
    expect(r.topModel).toBe('claude-opus-5');
    expect(r.activeDays).toBe(2);
  });
});
