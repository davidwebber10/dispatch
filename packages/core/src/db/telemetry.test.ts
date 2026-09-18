import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from './schema.js';
import { recordMeasurement, type Measurement } from './telemetry.js';
import { openTurn, closeTurn } from './usage.js';
import { summary, top, series } from '../analytics/queries.js';
import { UsageRecorder } from '../usage/recorder.js';

let db: Database.Database;
const at = '2026-09-18T10:00:00Z';
const ctx = { terminalId: 't', provider: 'codex', sessionId: 's', now: at };
const m = (extra: Partial<Measurement> = {}): Measurement => ({ input: 10, output: 2, cacheRead: 0, cacheCreate: 0, model: 'claude-sonnet-5', source: 'structured', eventId: 'response1', ...extra });
const open = (id: string) => openTurn(db, { id, terminalId: 't', projectId: 'p', provider: 'codex', model: '', role: '', startedAt: at, transport: 'structured' });
beforeEach(() => { db = new Database(':memory:'); initSchema(db); open('turn'); });

describe('durable telemetry ledger', () => {
  it('migration is idempotent', () => {
    recordMeasurement(db, 'turn', ctx, m()); initSchema(db); initSchema(db);
    expect((db.prepare('SELECT COUNT(*) n FROM usage_facts').get() as any).n).toBe(1);
  });
  it('deduplicates response snapshots and accepts only increasing usage', () => {
    recordMeasurement(db, 'turn', ctx, m()); recordMeasurement(db, 'turn', ctx, m());
    recordMeasurement(db, 'turn', ctx, m({ output: 5 })); recordMeasurement(db, 'turn', ctx, m({ output: 3 }));
    expect(db.prepare('SELECT input_tokens,output_tokens FROM usage_turns').get()).toEqual({ input_tokens: 10, output_tokens: 5 });
  });
  it('rejects a replay belonging to a previous turn', () => {
    recordMeasurement(db, 'turn', ctx, m()); closeTurn(db, 'turn', at, 'idle'); open('next');
    expect(recordMeasurement(db, 'next', ctx, m())).toBe(false);
    expect((db.prepare("SELECT input_tokens FROM usage_turns WHERE id='next'").get() as any).input_tokens).toBe(0);
  });
  it('cumulative checkpoints survive a new turn and only add the new delta', () => {
    recordMeasurement(db, 'turn', ctx, m({ counter: { key: 'tokens', totals: { input: 100, output: 20, cacheRead: 0, cacheCreate: 0 } } }));
    closeTurn(db, 'turn', at, 'idle'); open('next');
    recordMeasurement(db, 'next', ctx, m({ counter: { key: 'tokens', totals: { input: 115, output: 23, cacheRead: 0, cacheCreate: 0 } } }));
    expect((db.prepare("SELECT input_tokens FROM usage_turns WHERE id='next'").get() as any).input_tokens).toBe(15);
  });
  it('rolls back checkpoints when a fact cannot be stored', () => {
    db.exec("CREATE TRIGGER fail_fact BEFORE INSERT ON usage_facts BEGIN SELECT RAISE(ABORT,'test failure'); END");
    expect(() => recordMeasurement(db, 'turn', ctx, m({ counter: { key: 'tokens', totals: { input: 20, output: 4, cacheRead: 0, cacheCreate: 0 } } }))).toThrow();
    expect((db.prepare('SELECT COUNT(*) n FROM usage_checkpoints').get() as any).n).toBe(0);
  });
  it('keeps mixed-model analytics and fleet totals consistent without multiplying turn counts', () => {
    recordMeasurement(db, 'turn', ctx, m());
    recordMeasurement(db, 'turn', ctx, m({ eventId: 'response2', model: 'claude-opus-5', input: 20 }));
    closeTurn(db, 'turn', '2026-09-18T10:00:10Z', 'idle');
    expect(top(db, { dimension: 'model' }).map(v => v.value).sort()).toEqual([12,22]);
    expect(summary(db, {}).totalTokens).toBe(34);
    expect(series(db, { metric: 'turns', groupBy: 'none' })[0].value).toBe(1);
    const fleet = new UsageRecorder(db, () => new Date(at));
    expect(fleet.total()).toEqual({ inputTokens: 30, outputTokens: 4, turns: 1 });
    expect(fleet.byModel()).toHaveLength(2);
  });
  it('distinguishes missing cost from a reported zero and keeps dollars separate from estimates', () => {
    recordMeasurement(db, 'turn', ctx, m({ model: 'unpriced', reportedCostUsd: 0 }));
    closeTurn(db, 'turn', at, 'idle');
    expect(summary(db, {})).toMatchObject({ apiValueUsd: 0, reportedCostUsd: 0, valueIsPartial: true });
  });
  it('rejects invalid measurements instead of corrupting totals', () => {
    expect(() => recordMeasurement(db, 'turn', ctx, m({ input: -1 }))).toThrow();
    expect(() => recordMeasurement(db, 'turn', ctx, m({ reportedCostUsd: NaN }))).toThrow();
  });
  it('preserves historical rows without fabricating granular facts or reported zero cost', () => {
    openTurn(db, { id: 'legacy', terminalId: 'old', projectId: 'p', provider: 'claude-code', model: 'claude-sonnet-5', role: '', startedAt: at });
    db.prepare("UPDATE usage_turns SET input_tokens=50, messages=1, ended_at=? WHERE id='legacy'").run(at);
    initSchema(db);
    expect(summary(db, {})).toMatchObject({ turns: 1, inputTokens: 50, reportedCostUsd: null, coverage: { partial: 1 } });
    expect((db.prepare('SELECT COUNT(*) n FROM usage_facts').get() as any).n).toBe(0);
  });
  it('keeps a known unchanged final cost at zero on the following turn', () => {
    const cost = m({ input: 0, output: 0, kind: 'cost', reportedCostUsd: 0.2,
      counter: { key: 'cost', unit: 'usd', totals: { input: 0.2, output: 0, cacheRead: 0, cacheCreate: 0 }, initialIsDelta: true, final: true } });
    recordMeasurement(db, 'turn', ctx, cost); closeTurn(db, 'turn', at, 'idle'); open('next');
    recordMeasurement(db, 'next', ctx, cost);
    expect(db.prepare("SELECT reported_cost_usd FROM usage_turns WHERE id='next'").get()).toEqual({ reported_cost_usd: 0 });
  });

});
