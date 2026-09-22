// packages/core/src/settings/overseer-workers.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { readOverseerWorkers, updateOverseerWorkers } from './overseer-workers.js';

function db() { const d = new Database(':memory:'); initSchema(d); return d; }

describe('overseer workers settings', () => {
  let d: ReturnType<typeof db>;
  beforeEach(() => { d = db(); });

  it('reads empty byType when nothing stored', () => {
    expect(readOverseerWorkers(d)).toEqual({ byType: {} });
  });

  it('stores and reads a per-type pick', () => {
    updateOverseerWorkers(d, { byType: { implementer: { harness: 'codex', model: 'gpt-5-codex' } } });
    expect(readOverseerWorkers(d).byType.implementer).toEqual({ harness: 'codex', model: 'gpt-5-codex' });
  });

  it('merges per type; null clears an entry', () => {
    updateOverseerWorkers(d, { byType: { planner: { harness: 'grok' }, implementer: { harness: 'codex' } } });
    updateOverseerWorkers(d, { byType: { planner: null } });
    const w = readOverseerWorkers(d);
    expect(w.byType.planner).toBeUndefined();
    expect(w.byType.implementer).toEqual({ harness: 'codex' });
  });

  it('changing only the harness drops the stale model from the previous harness', () => {
    updateOverseerWorkers(d, { byType: { implementer: { harness: 'codex', model: 'gpt-5-codex' } } });
    updateOverseerWorkers(d, { byType: { implementer: { harness: 'grok' } } });
    expect(readOverseerWorkers(d).byType.implementer).toEqual({ harness: 'grok' });
  });

  it('changing the harness AND supplying a new model keeps both', () => {
    updateOverseerWorkers(d, { byType: { implementer: { harness: 'codex', model: 'gpt-5-codex' } } });
    updateOverseerWorkers(d, { byType: { implementer: { harness: 'grok', model: 'grok-4' } } });
    expect(readOverseerWorkers(d).byType.implementer).toEqual({ harness: 'grok', model: 'grok-4' });
  });

  it('drops unknown harnesses, unknown persona types, and empty entries', () => {
    updateOverseerWorkers(d, { byType: { implementer: { harness: 'shell' }, wizard: { harness: 'codex' }, planner: {} } } as never);
    expect(readOverseerWorkers(d)).toEqual({ byType: {} });
  });
});
