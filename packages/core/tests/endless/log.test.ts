import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { EndlessStore } from '../../src/endless/store.js';
import { ViewKeeper } from '../../src/endless/view-keeper.js';
import { Compactor } from '../../src/endless/compactor.js';
import { appendLogged } from '../../src/endless/log.js';
import { FakeSummarizer } from './fake-summarizer.js';

function setup() {
  const db = new Database(':memory:');
  initSchema(db);
  const store = new EndlessStore(db);
  const views = new ViewKeeper(store);
  const compactor = new Compactor({ store, views, summarizer: new FakeSummarizer(), systemPrompt: () => 'SYS', projectName: () => null });
  return { db, store, views, compactor };
}

describe('appendLogged with a claim', () => {
  it('logs when the claim succeeds, and only once', () => {
    const t = setup();
    t.store.armReport('t1', 1);
    const claim = () => t.store.claimReport('t1');
    expect(appendLogged(t, { kind: 'work', text: '[A] report: ok', ref: 't1' }, { claim })).toHaveLength(1);
    expect(appendLogged(t, { kind: 'work', text: '[A] report: ok', ref: 't1' }, { claim })).toEqual([]);
    expect(t.store.count()).toBe(1);
    expect(t.views.lines()).toHaveLength(1);
  });

  it('a claim and an append that fail together leave the report pending', () => {
    const t = setup();
    t.store.armReport('t1', 1);
    const boom = () => { t.store.claimReport('t1'); throw new Error('disk full'); };
    expect(() => appendLogged(t, { kind: 'work', text: 'x', ref: 't1' }, { claim: boom })).toThrow('disk full');
    expect(t.store.count()).toBe(0);
    expect(t.store.hasPendingReport('t1')).toBe(true); // rolled back with the transaction
  });

  it('a delete that throws leaves the log, the views, and the saved views unchanged', () => {
    const t = setup();
    appendLogged(t, { kind: 'user', text: 'before' });
    t.store.armReport('t1', 1);
    const lines = t.views.lines();
    const rendered = t.views.rendered();
    const epoch = t.views.epoch;
    const saved = t.store.getState('view');
    t.db.exec(`CREATE TRIGGER fail_claim BEFORE DELETE ON endless_pending_reports
      BEGIN SELECT RAISE(ABORT, 'delete failed'); END;`);
    expect(() => appendLogged(t, { kind: 'work', text: 'report', ref: 't1' }, { claim: () => t.store.claimReport('t1') }))
      .toThrow('delete failed');
    expect(t.store.count()).toBe(1);
    expect(t.views.lines()).toEqual(lines);
    expect(t.views.rendered()).toBe(rendered);
    expect(t.views.epoch).toBe(epoch);
    expect(t.store.getState('view')).toBe(saved);
    expect(t.store.hasPendingReport('t1')).toBe(true);
  });

  it('a view save that throws after the claim rolls the claim back too', () => {
    const t = setup();
    t.store.armReport('t1', 1);
    const saved = t.store.getState('view');
    t.db.exec(`CREATE TRIGGER fail_save BEFORE UPDATE ON endless_state
      BEGIN SELECT RAISE(ABORT, 'save failed'); END;
      CREATE TRIGGER fail_save_insert BEFORE INSERT ON endless_state
      BEGIN SELECT RAISE(ABORT, 'save failed'); END;`);
    expect(() => appendLogged(t, { kind: 'work', text: 'report', ref: 't1' }, { claim: () => t.store.claimReport('t1') }))
      .toThrow('save failed');
    expect(t.store.count()).toBe(0);
    expect(t.views.lines()).toEqual([]);
    expect(t.store.getState('view')).toBe(saved);
    expect(t.store.hasPendingReport('t1')).toBe(true);
  });

  it('splits a long claimed report into consecutive messages, never clips it', () => {
    const t = setup();
    t.store.armReport('t1', 1);
    const text = 'word '.repeat(20_000);
    const written = appendLogged(t, { kind: 'work', text, ref: 't1' }, { claim: () => t.store.claimReport('t1') });
    expect(written.length).toBeGreaterThan(1);
    expect(written.map((m) => m.text).join('')).toBe(text);
    expect(t.views.lines()).toHaveLength(written.length);
    expect(t.store.hasPendingReport('t1')).toBe(false);
  });
});
