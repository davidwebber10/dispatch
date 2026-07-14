import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { revealIn, tabChipSelector } from './reveal';

describe('revealIn', () => {
  let revealed: Element[];
  let opts: unknown[];

  beforeEach(() => {
    revealed = [];
    opts = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element, o?: unknown) {
      revealed.push(this);
      opts.push(o);
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  function container(html: string): HTMLElement {
    const c = document.createElement('div');
    c.innerHTML = html;
    return c;
  }

  it('reveals the matching element', () => {
    const c = container('<a data-tab-id="t1"></a><a data-tab-id="t2"></a>');
    expect(revealIn(c, '[data-tab-id="t2"]')).toBe(true);
    expect(revealed).toHaveLength(1);
    expect((revealed[0] as HTMLElement).dataset.tabId).toBe('t2');
  });

  it("asks for 'nearest' in BOTH axes — that is what makes an already-visible row a no-op", () => {
    // If this ever became 'start'/'center', every tab click would yank the strip and the sidebar
    // even when the user is already looking straight at the thing they picked.
    const c = container('<a data-tab-id="t1"></a>');
    revealIn(c, '[data-tab-id="t1"]');
    expect(opts[0]).toEqual({ block: 'nearest', inline: 'nearest' });
  });

  it('does nothing and reports false when nothing matches', () => {
    const c = container('<a data-tab-id="t1"></a>');
    expect(revealIn(c, '[data-tab-id="nope"]')).toBe(false);
    expect(revealed).toHaveLength(0);
  });

  it('tolerates a null container (ref not attached yet)', () => {
    expect(revealIn(null, '[data-tab-id="t1"]')).toBe(false);
    expect(revealed).toHaveLength(0);
  });
});

describe('tabChipSelector', () => {
  let revealed: Element[];
  beforeEach(() => {
    revealed = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) { revealed.push(this); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('matches a plain chip by its own id', () => {
    const c = document.createElement('div');
    c.innerHTML = '<a data-tab-id="t1"></a><a data-tab-id="t2"></a>';
    expect(revealIn(c, tabChipSelector('t2'))).toBe(true);
    expect((revealed[0] as HTMLElement).dataset.tabId).toBe('t2');
  });

  it('matches a GROUP chip that merely CONTAINS the id', () => {
    // A merged group has no chip of its own per tab — the group chip is the only strip presence
    // its panes have, so activating a tab inside it must reveal the group.
    const c = document.createElement('div');
    c.innerHTML = '<a data-tab-id="t9"></a><a data-tab-ids="t1 t2 t3"></a>';
    expect(revealIn(c, tabChipSelector('t2'))).toBe(true);
    expect((revealed[0] as HTMLElement).dataset.tabIds).toBe('t1 t2 t3');
  });

  it('does not match a group by a partial id', () => {
    const c = document.createElement('div');
    c.innerHTML = '<a data-tab-ids="t1 t2"></a>';
    expect(revealIn(c, tabChipSelector('t'))).toBe(false);
  });
});
