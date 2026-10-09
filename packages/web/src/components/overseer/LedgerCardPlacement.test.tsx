// Where the pinned card sits (pinned card spec 2026-10-08, Unit 7): desktop, at the top of the right
// pane's Details tab, above "Ongoing work"; mobile, at the top of the Work tab, with the open
// decision count on the tab.
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DispatchWorkPane } from './components/DispatchWorkPane';
import { OverseerMobile } from './OverseerMobile';
import { useOverseer } from './store';
import { useLedgerCard } from '../../stores/ledgerCard';
import { useProjects } from '../../stores/projects';
import { FIXTURE } from './ledger-fixture';

const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }));
  useProjects.setState({ activeId: 'p1' } as never);
  useLedgerCard.setState({ byProject: { p1: { card: FIXTURE, loading: false, error: null, request: 1 } } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the pinned card placement', () => {
  it('desktop: the top of the Details pane, above "Ongoing work"', () => {
    render(<DispatchWorkPane />);
    expect(before(screen.getByTestId('ledger-card'), screen.getByText('Ongoing work'))).toBe(true);
  });

  it('mobile: the top of the Work tab, with the open decision count on the tab', () => {
    useOverseer.setState({ mobileTab: 'stream' });
    render(<OverseerMobile />);
    expect(screen.queryByTestId('ledger-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('work-decision-count')).toHaveTextContent('3');
    fireEvent.click(screen.getByRole('button', { name: /^Work/ }));
    expect(before(screen.getByTestId('ledger-card'), screen.getByText('Ongoing work'))).toBe(true);
  });
});
