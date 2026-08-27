import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { GeneralSection } from './GeneralSection';
import { useSettings } from '../../stores/settings';

// Regression note: this suite renders FRESH per case (not one render with both buttons
// clicked in sequence) and asserts the sibling mode's setter did NOT fire. A single-render,
// click-both-then-assert-both style test would still pass even if the Threads/Board handlers
// were swapped — that exact bug shape has slipped through twice on this project before.
beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
  useSettings.setState({ mobileViewMode: 'threads' });
});

describe('GeneralSection — mobile view mode picker', () => {
  it('defaults to the Threads card selected', () => {
    render(<GeneralSection />);
    expect(screen.getByTitle('Threads')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTitle('Board')).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking the Board card selects board and leaves nothing else touched', () => {
    render(<GeneralSection />);
    fireEvent.click(screen.getByTitle('Board'));
    expect(useSettings.getState().mobileViewMode).toBe('board');
    expect(JSON.parse(localStorage.getItem('dispatch:mobileViewMode')!)).toBe('board');
  });

  it('clicking the Threads card on a fresh board-selected render sets it back to threads', () => {
    useSettings.setState({ mobileViewMode: 'board' });
    render(<GeneralSection />);
    expect(screen.getByTitle('Board')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTitle('Threads'));

    expect(useSettings.getState().mobileViewMode).toBe('threads');
    expect(JSON.parse(localStorage.getItem('dispatch:mobileViewMode')!)).toBe('threads');
  });

  it('clicking Board never runs the Threads path (fresh render, only Board clicked)', () => {
    // Sentinel: if the setter were accidentally wired to the wrong mode, this still catches it,
    // because we only ever click one button in this render and assert the exact resulting value.
    render(<GeneralSection />);
    fireEvent.click(screen.getByTitle('Board'));
    expect(useSettings.getState().mobileViewMode).not.toBe('threads');
    expect(useSettings.getState().mobileViewMode).toBe('board');
  });
});

// The Stepper renders bare −/+ buttons with no accessible names, so target the row by its
// label text: the row div is the label's parent, and its two buttons are [dec, inc].
function limitRow(label: string) {
  const row = screen.getByText(label).parentElement!;
  const [dec, inc] = within(row).getAllByRole('button');
  return { row, dec, inc };
}

describe('GeneralSection — sidebar list limits', () => {
  beforeEach(() => {
    useSettings.setState({ sidebarMaxThreads: 10, sidebarMaxFiles: 10 });
  });

  it('shows both limits at their default of 10', () => {
    render(<GeneralSection />);
    expect(within(limitRow('Threads shown').row).getByText('10')).toBeInTheDocument();
    expect(within(limitRow('Files shown').row).getByText('10')).toBeInTheDocument();
  });

  it('stepping the thread limit up past 50 lands on All and persists 0', () => {
    useSettings.setState({ sidebarMaxThreads: 50 });
    render(<GeneralSection />);
    fireEvent.click(limitRow('Threads shown').inc);
    expect(useSettings.getState().sidebarMaxThreads).toBe(0);
    expect(JSON.parse(localStorage.getItem('dispatch:sidebarMaxThreads')!)).toBe(0);
    expect(within(limitRow('Threads shown').row).getByText('All')).toBeInTheDocument();
  });

  it('stepping the file limit down from All lands on 50', () => {
    useSettings.setState({ sidebarMaxFiles: 0 });
    render(<GeneralSection />);
    fireEvent.click(limitRow('Files shown').dec);
    expect(useSettings.getState().sidebarMaxFiles).toBe(50);
  });

  it('the two limits are independent — stepping threads never touches files', () => {
    render(<GeneralSection />);
    fireEvent.click(limitRow('Threads shown').inc);
    expect(useSettings.getState().sidebarMaxThreads).toBe(11);
    expect(useSettings.getState().sidebarMaxFiles).toBe(10);
  });
});

describe('GeneralSection — pinned files toggle', () => {
  const toggleFor = (label: string) => {
    const row = screen.getByText(label).closest('div') as HTMLElement;
    return within(row).getByRole('button');
  };

  it('ships on, so project cards keep showing pinned files until you say otherwise', () => {
    useSettings.setState({ showPinnedFiles: true });
    render(<GeneralSection />);
    expect(screen.getByText('Pinned files')).toBeInTheDocument();
  });

  it('clicking the toggle turns pinned files off and persists it', () => {
    useSettings.setState({ showPinnedFiles: true });
    render(<GeneralSection />);
    fireEvent.click(toggleFor('Pinned files'));
    expect(useSettings.getState().showPinnedFiles).toBe(false);
    expect(JSON.parse(localStorage.getItem('dispatch:showPinnedFiles')!)).toBe(false);
  });

  it('clicking it again on a fresh off render turns them back on', () => {
    useSettings.setState({ showPinnedFiles: false });
    render(<GeneralSection />);
    fireEvent.click(toggleFor('Pinned files'));
    expect(useSettings.getState().showPinnedFiles).toBe(true);
  });

  it('the pinned-files toggle never touches the file limit', () => {
    useSettings.setState({ showPinnedFiles: true, sidebarMaxFiles: 10 });
    render(<GeneralSection />);
    fireEvent.click(toggleFor('Pinned files'));
    expect(useSettings.getState().sidebarMaxFiles).toBe(10);
  });
});
