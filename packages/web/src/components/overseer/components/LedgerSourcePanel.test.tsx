// Source links and the section panel (titles and source panel spec 2026-10-09, Unit 10). On the
// card, a plan, doc or agent-with-file Source line opens the panel; a PR or issue source with a
// link opens GitHub in a new tab. The panel shows only the section, with the item's row marked.
import { render, screen, fireEvent, cleanup, within, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../lib/openFileTab', () => ({ openFileTab: vi.fn(async () => {}) }));
// The placement tests check only where the panel sits: the chat itself is a stub here.
vi.mock('./Stream', () => ({ ConversationStream: () => <div data-testid="stream-stub" /> }));
vi.mock('./Composer', () => ({ Composer: () => <div data-testid="composer-stub" /> }));

import { openFileTab } from '../../../lib/openFileTab';
import { api } from '../../../api/client';
import { useOverseer } from '../store';
import { useProjects } from '../../../stores/projects';
import { useLedgerCard, useLedgerFolds } from '../../../stores/ledgerCard';
import { LedgerCard } from './LedgerCard';
import { LedgerSourcePanel } from './LedgerSourcePanel';
import { LedgerRefPopover } from './LedgerChips';
import { OverseerView } from '../OverseerView';
import { OverseerMobile } from '../OverseerMobile';
import { FIXTURE, N12, NOW, cardItem } from '../ledger-fixture';
import type { CardSource, LedgerCard as Card, LedgerSource } from '../../../api/types';

const TABLE = [
  '| ID | Question | Recommendation |',
  '|---|---|---|',
  '| LR-60 | Which night is the cut-off? | Sunday |',
  '| LR-6 | How many clean nights before live mode? | A. 5 nights |',
].join('\n');

const SECTION: LedgerSource = {
  kind: 'section', file: 'readiness.md', path: 'docs/plans/readiness.md',
  heading: 'Open owner decisions after v3.2 (the v3 table, updated 2026-10-08)', markdown: TABLE,
  id: 'LR-6', fromMainCheckout: false, note: null, cut: false,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const withSource = (seq: number, source: CardSource): Card => ({
  ...FIXTURE,
  sections: { ...FIXTURE.sections, needsYou: { cards: [cardItem({ seq, kind: 'go', text: 'Merge PR #62 into main?', source })], lines: [] } },
});
const showCard = (card: Card) => useLedgerCard.setState({ byProject: { p1: { card, loading: false, error: null, request: 1 } } });
const sourceField = (seq: number) => within(document.querySelector(`[data-ledger-seq="${seq}"][data-full="true"]`) as HTMLElement).getByTestId('ledger-source');

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
  Element.prototype.scrollTo = Element.prototype.scrollTo || (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }));
  localStorage.clear();
  useProjects.setState({ activeId: 'p1' } as never);
  useOverseer.setState({ mobileTab: 'work' });
  useLedgerFolds.setState({ open: {} });
  useLedgerCard.setState({ byProject: { p1: { card: FIXTURE, loading: false, error: null, request: 1 } }, focus: null, popover: null, sourcePanel: null });
  vi.mocked(openFileTab).mockClear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('the Source line on the card', () => {
  it('a plan, doc or agent-with-file source is a button that opens the panel for its item', () => {
    render(<LedgerCard />);
    const button = within(sourceField(14)).getByRole('button', { name: /readiness\.md/ });
    fireEvent.click(button);
    expect(useLedgerCard.getState().sourcePanel).toEqual({ projectId: 'p1', seq: 14 });
    for (const source of [
      { kind: 'plan', ref: 'docs/plans/a.md', path: null, section: 'Risks', id: 'D3', url: null },
      { kind: 'doc', ref: 'docs/notes.md', path: null, section: null, id: null, url: null },
    ] as CardSource[]) {
      cleanup();
      showCard(withSource(7, source));
      render(<LedgerCard />);
      expect(within(sourceField(7)).getByRole('button')).toBeInTheDocument();
    }
  });

  it('a PR or issue source with a link opens GitHub in a new tab', () => {
    showCard(withSource(12, { ...N12.source!, url: 'https://github.com/owner/repo/pull/62' }));
    render(<LedgerCard />);
    const link = within(sourceField(12)).getByRole('link', { name: 'PR #62' });
    expect(link).toHaveAttribute('href', 'https://github.com/owner/repo/pull/62');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('other sources stay text: a PR without a link, the overseer, an agent without a file', () => {
    for (const source of [
      N12.source!,
      { kind: 'overseer', ref: null, path: null, section: null, id: null, url: null },
      { kind: 'agent', ref: 'Map researcher', path: null, section: 'Q2 part', id: null, url: null },
    ] as CardSource[]) {
      cleanup();
      showCard(withSource(12, source));
      render(<LedgerCard />);
      expect(within(sourceField(12)).queryByRole('button'), source.kind).toBeNull();
      expect(within(sourceField(12)).queryByRole('link'), source.kind).toBeNull();
    }
  });
});

describe('the section panel', () => {
  const open = (seq = 14) => useLedgerCard.setState({ sourcePanel: { projectId: 'p1', seq } });

  it('loading shows a short placeholder; then the file name, the heading and the section, with the item\'s row marked and in view', async () => {
    const d = deferred<LedgerSource>();
    const get = vi.spyOn(api, 'getLedgerSource').mockReturnValue(d.promise);
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    open();
    render(<LedgerSourcePanel />);
    expect(screen.getByText('Loading the section…')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('p1', 14, undefined);
    await act(async () => { d.resolve(SECTION); });
    const panel = screen.getByTestId('ledger-source-panel');
    expect(within(panel).getByText('readiness.md')).toBeInTheDocument();
    expect(within(panel).getByText('Open owner decisions after v3.2 (the v3 table, updated 2026-10-08)')).toBeInTheDocument();
    expect(within(panel).queryByText('From the main checkout: the worktree is gone.')).toBeNull();
    expect(within(panel).queryByText('The section continues in the file.')).toBeNull();
    const marked = panel.querySelectorAll('[data-source-mark]');
    expect(marked).toHaveLength(1);
    expect(marked[0].tagName).toBe('TR');
    expect(marked[0].textContent).toContain('How many clean nights before live mode?'); // LR-6, not LR-60
    expect(scroll.mock.contexts).toContain(marked[0]);
  });

  it('the flags: from the main checkout, and a cut section', async () => {
    // Review round 1: the daemon's note names the copy the panel reads.
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue({ ...SECTION, fromMainCheckout: true, note: 'From the main checkout: the worktree does not have this file.', cut: true });
    open();
    render(<LedgerSourcePanel />);
    expect(await screen.findByText('From the main checkout: the worktree does not have this file.')).toBeInTheDocument();
    expect(screen.getByText('The section continues in the file.')).toBeInTheDocument();
  });

  it('no table row with the ID: the first block that contains it is marked', async () => {
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue({ ...SECTION, markdown: 'Intro text.\n\nThe weekend runs matter for LR-6 most.\n\n- LR-6 again' });
    open();
    render(<LedgerSourcePanel />);
    await screen.findByText('Intro text.');
    const marked = document.querySelectorAll('[data-source-mark]');
    expect(marked).toHaveLength(1);
    expect(marked[0].tagName).toBe('P');
    expect(marked[0].textContent).toBe('The weekend runs matter for LR-6 most.');
  });

  it('the outline: a list of the headings; a click loads that section', async () => {
    const get = vi.spyOn(api, 'getLedgerSource')
      .mockResolvedValueOnce({ kind: 'outline', file: 'readiness.md', path: 'docs/plans/readiness.md', fromMainCheckout: false, note: null, headings: [{ level: 1, text: 'Example plan' }, { level: 2, text: 'Background' }] })
      .mockResolvedValueOnce({ ...SECTION, heading: 'Background', markdown: 'Some history.', id: null });
    open();
    render(<LedgerSourcePanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Background' }));
    expect(await screen.findByText('Some history.')).toBeInTheDocument();
    expect(get).toHaveBeenLastCalledWith('p1', 14, 'Background');
  });

  it('file-only: the reason and the button that opens the full file in its tab', async () => {
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue({
      kind: 'file-only', file: 'notes.txt', path: '.claude/worktrees/wt-a/docs/notes.txt', fromMainCheckout: false,
      note: 'From the worktree "wt-a": the main checkout does not have this file.', reason: 'This file is not markdown, so the panel cannot show a section of it.',
    });
    open();
    render(<LedgerSourcePanel />);
    expect(await screen.findByText('This file is not markdown, so the panel cannot show a section of it.')).toBeInTheDocument();
    expect(screen.getByText('From the worktree "wt-a": the main checkout does not have this file.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open the full file' }));
    expect(openFileTab).toHaveBeenCalledWith('p1', '.claude/worktrees/wt-a/docs/notes.txt', { focus: true });
  });

  it('"Open the full file" from a section opens the file tab and brings it to the front', async () => {
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue({ ...SECTION, path: 'docs/plans/readiness.md' });
    open();
    render(<LedgerSourcePanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open the full file' }));
    expect(openFileTab).toHaveBeenCalledWith('p1', 'docs/plans/readiness.md', { focus: true });
  });

  it('an error shows "Could not load the section", the reason, and Retry', async () => {
    const get = vi.spyOn(api, 'getLedgerSource')
      .mockRejectedValueOnce(new Error('GET /api/sessions/p1/ledger/N14/source failed: 404 — The file is gone'))
      .mockResolvedValueOnce(SECTION);
    open();
    render(<LedgerSourcePanel />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the section');
    expect(alert).toHaveTextContent('The file is gone');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('readiness.md')).toBeInTheDocument();
  });

  it('Escape and ✕ close it', async () => {
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue(SECTION);
    open();
    render(<LedgerSourcePanel />);
    await screen.findByText('readiness.md');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useLedgerCard.getState().sourcePanel).toBeNull();
    expect(screen.queryByTestId('ledger-source-panel')).toBeNull();
    act(() => open());
    await screen.findByText('readiness.md');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useLedgerCard.getState().sourcePanel).toBeNull();
  });

  it('a click on another Source line replaces it', async () => {
    const get = vi.spyOn(api, 'getLedgerSource')
      .mockResolvedValueOnce(SECTION)
      .mockResolvedValueOnce({ ...SECTION, file: 'other.md', heading: 'Risks', markdown: 'A risk.' });
    open(14);
    render(<LedgerSourcePanel />);
    await screen.findByText('readiness.md');
    act(() => open(9));
    expect(await screen.findByText('other.md')).toBeInTheDocument();
    expect(screen.queryByText('readiness.md')).toBeNull();
    expect(get).toHaveBeenLastCalledWith('p1', 9, undefined);
  });

  it('a change of project closes it', async () => {
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue(SECTION);
    open();
    render(<LedgerSourcePanel />);
    await screen.findByText('readiness.md');
    act(() => useProjects.setState({ activeId: 'p2' } as never));
    expect(useLedgerCard.getState().sourcePanel).toBeNull();
    expect(screen.queryByTestId('ledger-source-panel')).toBeNull();
  });
});

// Review round 1 (2026-10-09): focus, the covered controls, Escape with a chip popover, the stacking.
describe('the panel and the keyboard', () => {
  it('focus moves into the panel when it opens and back to the opener when it closes', async () => {
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue(SECTION);
    render(<><button type="button">opener</button><LedgerSourcePanel /></>);
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    act(() => useLedgerCard.setState({ sourcePanel: { projectId: 'p1', seq: 14 } }));
    const panel = await screen.findByRole('dialog', { name: 'Source section' });
    expect(document.activeElement).toBe(panel);
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(opener);
  });

  it('desktop: the chat under the panel is inert while it is open; the card stays usable', async () => {
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue(SECTION);
    useLedgerCard.setState({ sourcePanel: { projectId: 'p1', seq: 14 } });
    render(<OverseerView />);
    const panel = await screen.findByTestId('ledger-source-panel');
    expect(screen.getByTestId('stream-stub').closest('[inert]')).not.toBeNull();
    expect(screen.getByTestId('composer-stub').closest('[inert]')).not.toBeNull();
    expect(panel.closest('[inert]')).toBeNull();
    act(() => useLedgerCard.getState().setSourcePanel(null));
    expect(screen.getByTestId('stream-stub').closest('[inert]')).toBeNull();
    expect(screen.getByTestId('composer-stub').closest('[inert]')).toBeNull();
  });

  it('phone: the Work tab under the sheet is inert while it is open', async () => {
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue(SECTION);
    render(<OverseerMobile />);
    fireEvent.click(within(sourceField(14)).getByRole('button'));
    const sheet = await screen.findByTestId('ledger-source-panel');
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('ledger-card').closest('[inert]')).not.toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('ledger-card').closest('[inert]')).toBeNull();
  });

  it('Escape with a chip popover open closes only the popover', async () => {
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue(SECTION);
    useLedgerCard.setState({ sourcePanel: { projectId: 'p1', seq: 14 }, popover: { projectId: 'p1', seq: 3, x: 10, y: 10 } });
    render(<LedgerSourcePanel />);
    await screen.findByText('readiness.md');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useLedgerCard.getState().sourcePanel).not.toBeNull();
  });

  // Review round 2: both components mounted, in both opening orders.
  for (const order of ['popover first', 'panel first'] as const) {
    it(`Escape with the real chip popover mounted (${order}) closes only the popover`, async () => {
      vi.spyOn(api, 'getLedgerSource').mockResolvedValue(SECTION);
      const seq = FIXTURE.index[0].seq;
      const popover = { projectId: 'p1', seq, x: 10, y: 10 };
      const panel = { projectId: 'p1', seq: 14 };
      useLedgerCard.setState(order === 'popover first' ? { popover } : { sourcePanel: panel });
      render(<><LedgerRefPopover /><LedgerSourcePanel /></>);
      act(() => useLedgerCard.setState(order === 'popover first' ? { sourcePanel: panel } : { popover }));
      await screen.findByText('readiness.md');
      expect(screen.getByRole('dialog', { name: `N${seq}` })).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(useLedgerCard.getState().popover).toBeNull();
      expect(useLedgerCard.getState().sourcePanel).not.toBeNull();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(useLedgerCard.getState().sourcePanel).toBeNull();
    });
  }

  it('A, then B, then close: focus goes back to B, the last Source line', async () => {
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue(SECTION);
    render(<><button type="button">source A</button><button type="button">source B</button><LedgerSourcePanel /></>);
    screen.getByRole('button', { name: 'source A' }).focus();
    act(() => useLedgerCard.setState({ sourcePanel: { projectId: 'p1', seq: 14 } }));
    await screen.findByText('readiness.md');
    screen.getByRole('button', { name: 'source B' }).focus();
    act(() => useLedgerCard.setState({ sourcePanel: { projectId: 'p1', seq: 9 } }));
    await screen.findByText('readiness.md');
    act(() => useLedgerCard.getState().setSourcePanel(null));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'source B' }));
  });

  it('desktop: the panel sits above the chat\'s floating buttons (z-index 5)', async () => {
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue(SECTION);
    useLedgerCard.setState({ sourcePanel: { projectId: 'p1', seq: 14 } });
    render(<LedgerSourcePanel />);
    expect(Number((await screen.findByTestId('ledger-source-panel')).style.zIndex)).toBeGreaterThan(5);
  });
});

describe('where the panel opens', () => {
  it('desktop: over the chat column of the Control Plane', async () => {
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue(SECTION);
    useLedgerCard.setState({ sourcePanel: { projectId: 'p1', seq: 14 } });
    render(<OverseerView />);
    const panel = await screen.findByTestId('ledger-source-panel');
    expect(panel.parentElement).toBe(screen.getByTestId('overseer-chat-column'));
    expect(panel.parentElement).toContainElement(screen.getByTestId('stream-stub'));
    expect(within(panel).queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('phone: a full-screen sheet over the Work tab, with a back button', async () => {
    vi.spyOn(api, 'getLedgerSource').mockResolvedValue(SECTION);
    render(<OverseerMobile />);
    fireEvent.click(within(sourceField(14)).getByRole('button'));
    const sheet = await screen.findByTestId('ledger-source-panel');
    expect(sheet).toHaveAttribute('data-sheet', 'true');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Back' }));
    expect(screen.queryByTestId('ledger-source-panel')).toBeNull();
    expect(screen.getByTestId('ledger-card')).toBeInTheDocument(); // the Work tab is still there
  });
});
