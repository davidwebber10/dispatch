import { describe, it, expect, beforeEach } from 'vitest';
import { getDraft, hasDraft, setDraft, clearDraft } from './fileDrafts';

// The draft map is module-level (that is the whole point — it outlives the component), so each
// test must clean up after itself or the state leaks into the next one.
const IDS = ['t1', 't2'];

describe('fileDrafts', () => {
  beforeEach(() => {
    for (const id of IDS) clearDraft(id);
  });

  it('reports no draft for a tab that has not been edited', () => {
    expect(hasDraft('t1')).toBe(false);
    expect(getDraft('t1')).toBeUndefined();
  });

  it('holds a tab\'s unsaved text and reports it as dirty', () => {
    setDraft('t1', 'edited text');

    expect(hasDraft('t1')).toBe(true);
    expect(getDraft('t1')).toBe('edited text');
  });

  it('overwrites the draft on each subsequent edit', () => {
    setDraft('t1', 'first');
    setDraft('t1', 'second');

    expect(getDraft('t1')).toBe('second');
  });

  it('keeps drafts separate per tab — two tabs on the same file are two edits', () => {
    setDraft('t1', 'a');
    setDraft('t2', 'b');

    expect(getDraft('t1')).toBe('a');
    expect(getDraft('t2')).toBe('b');
  });

  it('clearDraft drops only that tab, and leaves the others alone', () => {
    setDraft('t1', 'a');
    setDraft('t2', 'b');

    clearDraft('t1');

    expect(hasDraft('t1')).toBe(false);
    expect(getDraft('t1')).toBeUndefined();
    expect(getDraft('t2')).toBe('b');    // t2's edit is untouched
  });

  it('treats an empty string as a real draft (you can delete a file\'s whole contents)', () => {
    setDraft('t1', '');

    expect(hasDraft('t1')).toBe(true);   // existence, not truthiness, is the dirty signal
    expect(getDraft('t1')).toBe('');
  });

  it('clearing a tab that has no draft is a no-op', () => {
    expect(() => clearDraft('t1')).not.toThrow();
    expect(hasDraft('t1')).toBe(false);
  });
});
