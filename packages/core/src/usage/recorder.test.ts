import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { UsageRecorder, modelOf } from './recorder.js';

const at = (iso: string) => () => new Date(iso);

function result(model: string, input: number, output: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'result',
    modelUsage: { [model]: {} },
    usage: { input_tokens: input, output_tokens: output, ...extra },
  };
}

describe('UsageRecorder', () => {
  test('folds result events into per-day, per-model totals', () => {
    const r = new UsageRecorder(new Database(':memory:'), at('2026-07-25T10:00:00Z'));
    r.observe(result('claude-sonnet-5', 100, 20));
    r.observe(result('claude-sonnet-5', 50, 10));
    r.observe(result('claude-opus-5', 10, 5));

    const byModel = r.byModel(7);
    expect(byModel.find((m) => m.model === 'claude-sonnet-5')).toMatchObject({
      inputTokens: 150, outputTokens: 30, turns: 2,
    });
    expect(byModel.find((m) => m.model === 'claude-opus-5')).toMatchObject({ turns: 1 });
    expect(r.total(7)).toEqual({ inputTokens: 160, outputTokens: 35, turns: 3 });
  });

  test('counts cache reads as input — they consume the cap too', () => {
    const r = new UsageRecorder(new Database(':memory:'), at('2026-07-25T10:00:00Z'));
    r.observe(result('m', 10, 1, { cache_read_input_tokens: 900, cache_creation_input_tokens: 90 }));
    expect(r.total(7).inputTokens).toBe(1000);
  });

  test('ignores non-result events and zero-usage results', () => {
    const r = new UsageRecorder(new Database(':memory:'), at('2026-07-25T10:00:00Z'));
    r.observe({ type: 'assistant', message: { content: [] } });
    r.observe({ type: 'result', usage: { input_tokens: 0, output_tokens: 0 } });
    r.observe(null);
    expect(r.total(7).turns).toBe(0);
  });

  test('a window excludes older days', () => {
    const db = new Database(':memory:');
    const old = new UsageRecorder(db, at('2026-07-01T10:00:00Z'));
    old.observe(result('m', 999, 999));
    const now = new UsageRecorder(db, at('2026-07-25T10:00:00Z'));
    now.observe(result('m', 5, 5));
    expect(now.total(7)).toEqual({ inputTokens: 5, outputTokens: 5, turns: 1 });
  });

  test('a broken database never propagates into the event stream', () => {
    // Telemetry must not be able to break a turn.
    const db = new Database(':memory:');
    const r = new UsageRecorder(db, at('2026-07-25T10:00:00Z'));
    db.close();
    expect(() => r.observe(result('m', 1, 1))).not.toThrow();
    expect(r.total(7)).toEqual({ inputTokens: 0, outputTokens: 0, turns: 0 });
  });

  test('modelOf prefers modelUsage, falls back, then unknown', () => {
    expect(modelOf({ modelUsage: { 'claude-opus-5': {} } })).toBe('claude-opus-5');
    expect(modelOf({ model: 'x' })).toBe('x');
    expect(modelOf({})).toBe('unknown');
  });
});
