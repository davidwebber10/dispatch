import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { EndlessStore } from '../../src/endless/store.js';
import { ViewKeeper } from '../../src/endless/view-keeper.js';
import { lineSize, PLACEHOLDER } from '../../src/endless/view.js';
import { siblingOf, parentOf } from '../../src/endless/tree.js';

const limits = { low: 2_000, high: 4_000, compactionLow: 800, compactionHigh: 1_600 };

/** Log one message and build every node that becomes buildable (all built, no model). */
function logBuilt(store: EndlessStore, keeper: ViewKeeper, text: string) {
  const m = store.append({ kind: 'user', text });
  let ref = { l: 0, i: m.i };
  store.appendNode(0, m.i, text);
  for (;;) {
    const sib = siblingOf(ref.l, ref.i);
    if (!store.isBuilt(sib.l, sib.i)) break;
    const p = parentOf(ref.l, ref.i);
    store.appendNode(p.l, p.i, `p${p.l}.${p.i} ` + 'y'.repeat(60));
    ref = p;
  }
  return keeper.onMessage(m.i);
}

describe('ViewKeeper', () => {
  it('merges the compaction view when the chat view merges, and keeps both sawtooths', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const store = new EndlessStore(db);
    const keeper = new ViewKeeper(store, limits);
    const size = lineSize((l, i) => store.nodeText(l, i));
    let chatMerges = 0;
    for (let k = 0; k < 400; k++) {
      const before = keeper.epoch;
      const r = logBuilt(store, keeper, `message ${k} ` + 'x'.repeat(50));
      const cvBytes = keeper.compactionLines().reduce((s, [l, i]) => s + size(l, i), 0);
      expect(cvBytes).toBeLessThanOrEqual(limits.compactionHigh + 100);
      if (r.merged) {
        chatMerges++;
        expect(keeper.epoch).toBe(before + 1);
        expect(cvBytes).toBeLessThanOrEqual(limits.compactionLow);
        expect(keeper.bytes()).toBeLessThanOrEqual(limits.low);
      }
    }
    expect(chatMerges).toBeGreaterThan(2);
  });

  it('loads the saved views at start and never rebuilds them', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const store = new EndlessStore(db);
    const a = new ViewKeeper(store, limits);
    for (let k = 0; k < 120; k++) logBuilt(store, a, `m${k} ` + 'x'.repeat(50));
    const saved = a.lines().map((l) => l.name);
    const b = new ViewKeeper(new EndlessStore(db), limits);
    expect(b.lines().map((l) => l.name)).toEqual(saved);
  });

  it('renders the turn view with placeholders for unbuilt lines', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const store = new EndlessStore(db);
    const keeper = new ViewKeeper(store, limits);
    store.append({ kind: 'user', text: 'hello' });
    keeper.onMessage(0);
    expect(keeper.turnBlocks().join('')).toBe(`<chat>\n0+1|${PLACEHOLDER}\n</chat>`);
    store.appendNode(0, 0, 'user: hello');
    expect(keeper.turnBlocks().join('')).toBe('<chat>\n0+1|user: hello\n</chat>');
  });
});
