import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from './schema.js';
import * as usageDb from './usage.js';

function db() { const d = new Database(':memory:'); initSchema(d); return d; }

const OPEN = {
  id: 't1', terminalId: 'term1', projectId: 'proj1', provider: 'claude-code',
  model: 'claude-opus-5', role: 'agent', startedAt: '2026-08-13T10:00:00.000Z',
};

describe('usage_turns db', () => {
  let d: Database.Database;
  beforeEach(() => { d = db(); });

  it('opens a turn that reads back as open', () => {
    usageDb.openTurn(d, OPEN);
    const row = usageDb.findOpenTurn(d, 'term1');
    expect(row?.id).toBe('t1');
    expect(row?.ended_at).toBeNull();
    expect(row?.input_tokens).toBe(0);
  });

  it('adds usage deltas cumulatively', () => {
    usageDb.openTurn(d, OPEN);
    usageDb.addUsage(d, 't1', { input: 10, output: 5, cacheRead: 2, cacheCreate: 1, messages: 1, toolCalls: 0 });
    usageDb.addUsage(d, 't1', { input: 3, output: 7, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 2 });
    const row = usageDb.findOpenTurn(d, 'term1')!;
    expect(row.input_tokens).toBe(13);
    expect(row.output_tokens).toBe(12);
    expect(row.cache_read_tokens).toBe(2);
    expect(row.messages).toBe(2);
    expect(row.tool_calls).toBe(2);
  });

  it('closes a turn so it is no longer open', () => {
    usageDb.openTurn(d, OPEN);
    usageDb.closeTurn(d, 't1', '2026-08-13T10:01:00.000Z', 'idle');
    expect(usageDb.findOpenTurn(d, 'term1')).toBeNull();
  });

  it('setModelIfEmpty fills a blank model but never overwrites one', () => {
    usageDb.openTurn(d, { ...OPEN, model: '' });
    usageDb.setModelIfEmpty(d, 't1', 'claude-sonnet-5');
    expect(usageDb.findOpenTurn(d, 'term1')!.model).toBe('claude-sonnet-5');
    usageDb.setModelIfEmpty(d, 't1', 'claude-haiku-4-5');
    expect(usageDb.findOpenTurn(d, 'term1')!.model).toBe('claude-sonnet-5');
  });

  it('deleteBackfilled removes only imported rows', () => {
    usageDb.insertClosed(d, { ...OPEN, id: 'live', endedAt: '2026-08-13T10:01:00.000Z', outcome: 'idle',
      input: 1, output: 1, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: false });
    usageDb.insertClosed(d, { ...OPEN, id: 'old', endedAt: '2026-08-01T10:01:00.000Z', outcome: 'idle',
      input: 1, output: 1, cacheRead: 0, cacheCreate: 0, messages: 1, toolCalls: 0, backfilled: true });
    expect(usageDb.deleteBackfilled(d)).toBe(1);
    const all = d.prepare('SELECT id FROM usage_turns').all() as { id: string }[];
    expect(all.map((r) => r.id)).toEqual(['live']);
  });
});
