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

  // The constraint: an unpriced model's tokens must be COUNTED as tokens but must
  // never contribute to the dollar figure, because we do not know what they would
  // have cost. Silently folding them in at some default rate would under- or
  // over-report; dropping them entirely would lose real usage.
  it('keeps an unpriced model out of the dollar figure but inside the token totals', () => {
    turn(d, {
      id: 'unpriced', startedAt: '2026-08-12T14:00:00.000Z', endedAt: '2026-08-12T14:00:10.000Z',
      model: 'some-future-model', input: 1_000_000, output: 0,
    });
    const s = summary(d, {});
    // The tokens are real and counted.
    expect(s.inputTokens).toBe(1_000_111);
    expect(s.unpricedTokens).toBe(1_000_000);
    // The value reflects ONLY the priced models. Compare against the same summary
    // taken before this turn existed, so the assertion cannot drift with the price table.
    const pricedOnly = summary(d, { to: '2026-08-12T13:00:00.000Z' });
    expect(s.notionalUsd).toBeCloseTo(pricedOnly.notionalUsd, 10);
  });

  it('reports all-time records', () => {
    const r = records(d);
    expect(r.totalTokens).toBe(168);
    expect(r.busiestDay).toBe('2026-08-10');
    expect(r.topModel).toBe('claude-opus-5');
    expect(r.activeDays).toBe(2);
  });
});
