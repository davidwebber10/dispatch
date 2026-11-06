import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { AppearanceSection } from './AppearanceSection';
import { useSettings } from '../../stores/settings';

// Regression note: these suites render FRESH per case and assert the sibling setting did NOT
// change. A single-render, click-both-then-assert-both style test would still pass even if two
// handlers were swapped — that exact bug shape has slipped through twice on this project before.
beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
  // showPinnedFiles is reset here, not just in its own describe: it gates whether the
  // "Files shown" row renders at all, so a case that leaves it off would break the
  // sidebar-limit suite depending on file order.
  useSettings.setState({ showPinnedFiles: true });
});

describe('AppearanceSection — what moved in, what left', () => {
  it('has no fixed Theme row', () => {
    render(<AppearanceSection />);
    expect(screen.queryByText('Theme')).toBeNull();
    expect(screen.queryByText('Dark')).toBeNull();
  });

  it('offers terminal autocorrect (also in the terminal + menu)', () => {
    useSettings.setState({ ptyAutocorrect: true });
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole('switch', { name: 'Autocorrect in the terminal composer' }));
    expect(useSettings.getState().ptyAutocorrect).toBe(false);
    expect(JSON.parse(localStorage.getItem('dispatch:ptyAutocorrect')!)).toBe(false);
  });

  it('offers the docs editor (also in Chat → Memory)', () => {
    useSettings.setState({ editor: '' });
    render(<AppearanceSection />);
    fireEvent.change(screen.getByLabelText('Open docs in'), { target: { value: 'cursor' } });
    expect(useSettings.getState().editor).toBe('cursor');
  });

  it('labels its switches for screen readers', () => {
    render(<AppearanceSection />);
    for (const name of ['Pinned files', 'Pretty hint', 'Multi-pane tabs (Operator)']) {
      expect(screen.getByRole('switch', { name })).toBeInTheDocument();
    }
  });

  it('flipping Pretty hint never touches multi-pane', () => {
    useSettings.setState({ showPrettyHint: true, multiPane: true });
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole('switch', { name: 'Pretty hint' }));
    expect(useSettings.getState().showPrettyHint).toBe(false);
    expect(useSettings.getState().multiPane).toBe(true);
  });
});

// The Stepper renders bare −/+ buttons with no accessible names, so target the row by its
// label text: the row div is the label's parent, and its two buttons are [dec, inc].
function limitRow(label: string) {
  const row = screen.getByText(label).parentElement!;
  const [dec, inc] = within(row).getAllByRole('button');
  return { row, dec, inc };
}

describe('AppearanceSection — sidebar list limits', () => {
  beforeEach(() => {
    useSettings.setState({ sidebarMaxThreads: 10, sidebarMaxFiles: 10 });
  });

  it('shows both limits at their default of 10', () => {
    render(<AppearanceSection />);
    expect(within(limitRow('Threads shown').row).getByText('10')).toBeInTheDocument();
    expect(within(limitRow('Files shown').row).getByText('10')).toBeInTheDocument();
  });

  it('stepping the thread limit up past 50 lands on All and persists 0', () => {
    useSettings.setState({ sidebarMaxThreads: 50 });
    render(<AppearanceSection />);
    fireEvent.click(limitRow('Threads shown').inc);
    expect(useSettings.getState().sidebarMaxThreads).toBe(0);
    expect(JSON.parse(localStorage.getItem('dispatch:sidebarMaxThreads')!)).toBe(0);
    expect(within(limitRow('Threads shown').row).getByText('All')).toBeInTheDocument();
  });

  it('stepping the file limit down from All lands on 50', () => {
    useSettings.setState({ sidebarMaxFiles: 0 });
    render(<AppearanceSection />);
    fireEvent.click(limitRow('Files shown').dec);
    expect(useSettings.getState().sidebarMaxFiles).toBe(50);
  });

  it('the two limits are independent — stepping threads never touches files', () => {
    render(<AppearanceSection />);
    fireEvent.click(limitRow('Threads shown').inc);
    expect(useSettings.getState().sidebarMaxThreads).toBe(11);
    expect(useSettings.getState().sidebarMaxFiles).toBe(10);
  });
});

describe('AppearanceSection — pinned files toggle', () => {
  const toggleFor = (label: string) => {
    const row = screen.getByText(label).closest('div') as HTMLElement;
    return within(row).getByRole('switch');
  };

  it('ships on, so project cards keep showing pinned files until you say otherwise', () => {
    useSettings.setState({ showPinnedFiles: true });
    render(<AppearanceSection />);
    expect(screen.getByText('Pinned files')).toBeInTheDocument();
  });

  it('clicking the toggle turns pinned files off and persists it', () => {
    useSettings.setState({ showPinnedFiles: true });
    render(<AppearanceSection />);
    fireEvent.click(toggleFor('Pinned files'));
    expect(useSettings.getState().showPinnedFiles).toBe(false);
    expect(JSON.parse(localStorage.getItem('dispatch:showPinnedFiles')!)).toBe(false);
  });

  it('clicking it again on a fresh off render turns them back on', () => {
    useSettings.setState({ showPinnedFiles: false });
    render(<AppearanceSection />);
    fireEvent.click(toggleFor('Pinned files'));
    expect(useSettings.getState().showPinnedFiles).toBe(true);
  });

  it('the pinned-files toggle never touches the file limit', () => {
    useSettings.setState({ showPinnedFiles: true, sidebarMaxFiles: 10 });
    render(<AppearanceSection />);
    fireEvent.click(toggleFor('Pinned files'));
    expect(useSettings.getState().sidebarMaxFiles).toBe(10);
  });
});
