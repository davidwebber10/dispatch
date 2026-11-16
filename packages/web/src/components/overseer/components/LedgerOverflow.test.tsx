// A long string with no spaces (an sftp or https address) must wrap inside the Ledger surfaces. A
// flex child cannot shrink below its longest unbroken word, so without a wrap rule the card grew
// wider than its pane and scrolled sideways (and the right bar with it). jsdom has no layout, so
// these tests check the rule itself: `overflow-wrap: anywhere` (it also lowers the min-content
// width that flex children measure) and no horizontal scroll on the card.
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { api } from '../../../api/client';
import { useProjects } from '../../../stores/projects';
import { useLedgerCard, useLedgerFolds } from '../../../stores/ledgerCard';
import { LedgerCard } from './LedgerCard';
import { LedgerSourcePanel } from './LedgerSourcePanel';
import { LedgerRefPopover } from './LedgerChips';
import { EMPTY_CARD, NOW, cardItem } from '../ledger-fixture';
import type { LedgerCard as Card } from '../../../api/types';

const URL = 'sftp://feeduser@files.example.com/Feeds/CatalogB2B/ProductExport_2026-11-16_FullCatalogWithVariantsAndMetafields_v3_final.csv';
const long = cardItem({
  seq: 41, title: `Move the feed to ${URL}`, text: `Read from ${URL}?`, context: `The job fetches ${URL} nightly.`,
  options: [{ label: 'A. keep', effect: `Keep ${URL}`, answerKey: 'A' }], recommendation: 'A. keep', why: URL,
});
const card: Card = {
  ...EMPTY_CARD,
  sections: { ...EMPTY_CARD.sections, needsYou: { cards: [long], lines: [] } },
  index: [{ seq: 41, kind: 'decide', status: 'open', text: long.text, title: long.title, answer: null }],
};

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }));
  localStorage.clear();
  useProjects.setState({ activeId: 'p1' } as never);
  useLedgerFolds.setState({ open: {} });
  useLedgerCard.setState({ byProject: { p1: { card, loading: false, error: null, request: 1 } }, focus: null, popover: null, sourcePanel: null });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Ledger surfaces wrap a long unbroken string', () => {
  it('the card wraps it and never scrolls sideways', () => {
    render(<LedgerCard />);
    const root = screen.getByTestId('ledger-card');
    expect(root.style.overflowWrap).toBe('anywhere');
    expect(root.style.overflowX).toBe('hidden');
    expect(['0', '0px']).toContain(root.style.minWidth);
  });

  it('the chip popover wraps it', () => {
    act(() => { useLedgerCard.getState().setPopover({ projectId: 'p1', seq: 41, x: 10, y: 10 }); });
    render(<LedgerRefPopover />);
    expect(screen.getByRole('dialog').style.overflowWrap).toBe('anywhere');
  });

  it('the source panel wraps a long heading and body', async () => {
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue({
      kind: 'section', file: 'plan.md', path: 'docs/plans/plan.md', heading: URL, markdown: `Feed: ${URL}`, id: null, fromMainCheckout: false, note: null, cut: false,
    });
    act(() => { useLedgerCard.getState().setSourcePanel({ projectId: 'p1', seq: 41 }); });
    render(<LedgerSourcePanel />);
    const body = await waitFor(() => {
      const el = document.querySelector('.ledger-source-body');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const scroller = body.parentElement as HTMLElement;
    expect(scroller.style.overflowWrap).toBe('anywhere');
  });
});
