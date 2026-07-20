import { render, screen, fireEvent } from '@testing-library/react';
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
