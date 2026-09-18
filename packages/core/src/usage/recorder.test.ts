import { expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { UsageRecorder } from './recorder.js';
import { initSchema } from '../db/schema.js';
import { insertClosed } from '../db/usage.js';

test('fleet reads the same historical ledger, with date filtering and cache input', () => {
  const db = new Database(':memory:'); initSchema(db);
  for (const [id, startedAt] of [['recent','2026-09-18T10:00:00Z'],['old','2025-01-01T00:00:00Z']]) {
    insertClosed(db, { id, startedAt, endedAt: startedAt, terminalId: 't', projectId: 'p', provider: 'claude-code', model: 'claude-sonnet-5', role: '', outcome: 'idle', input: 10, output: 2, cacheRead: 5, cacheCreate: 1, messages: 1, toolCalls: 0, backfilled: false });
  }
  const reader = new UsageRecorder(db, () => new Date('2026-09-18T11:00:00Z'));
  expect(reader.total()).toEqual({ inputTokens: 16, outputTokens: 2, turns: 1 });
  expect(reader.byModel()[0].model).toBe('claude-sonnet-5');
});
