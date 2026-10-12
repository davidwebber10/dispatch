// The footer under a CLI thread's terminal (2026-10-12): while a turn runs, and for a short time
// after it settles, it keeps the height it had when the turn began, so the terminal resizes at most
// once per turn (each resize makes Codex's inline TUI clear its scrollback and reprint about 1000
// lines).
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { SETTLE_HOLD_MS, TurnFooter } from './TurnFooter';
import { useThreadStatus } from '../../stores/threadStatus';

const setStatus = (threadStatus: string, id = 't1') =>
  act(() => { useThreadStatus.setState({ byTerminal: { [id]: { threadStatus } } } as any); });

beforeEach(() => { useThreadStatus.setState({ byTerminal: {} } as any); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function Footer({ show, id = 't1' }: { show: boolean; id?: string }) {
  return <TurnFooter terminalId={id}>{show && <div data-testid="strip">asking you</div>}</TurnFooter>;
}

test('while a turn runs, and for a short time after it settles, the footer keeps the height it had when the turn began', () => {
  setStatus('idle');
  const { rerender } = render(<Footer show />);
  const footer = screen.getByTestId('turn-footer');
  // The exact height, not offsetHeight: a rounded hold (131 for 131.6) still resizes the terminal by
  // a pixel, and xterm can measure its rows again on that resize (seen in the browser check).
  footer.getBoundingClientRect = () => ({ height: 64.5 }) as DOMRect;
  rerender(<Footer show />); // measured while settled
  expect(footer.style.height).toBe('');

  setStatus('working');
  rerender(<Footer show={false} />); // the strip goes away as the turn starts
  expect(footer.style.height).toBe('64.5px');
  expect(footer.style.overflow).toBe('hidden');

  setStatus('idle'); // settled: the new outcome is still on its way, so the hold stays a little longer
  expect(footer.style.height).toBe('64.5px');
  act(() => { vi.advanceTimersByTime(SETTLE_HOLD_MS); });
  expect(footer.style.height).toBe('');
});

test('a footer that was empty when the turn began holds no height', () => {
  setStatus('idle');
  const { rerender } = render(<Footer show={false} />);
  setStatus('working');
  rerender(<Footer show={false} />);
  expect(screen.getByTestId('turn-footer').style.height).toBe('');
});

// Browser check (2026-10-12): the card updates its own text after the turn settles (it refetches the
// outcome), which does not re-render the footer, so a height measured only on the footer's own
// renders was stale (130.6 for 132) and the terminal still moved. A ResizeObserver keeps it current.
test('a height change inside the footer while settled is held too (ResizeObserver)', () => {
  const observers: Array<() => void> = [];
  const RO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} unobserve() {} } as any;
  try {
    setStatus('idle');
    const { rerender } = render(<Footer show />);
    const footer = screen.getByTestId('turn-footer');
    footer.getBoundingClientRect = () => ({ height: 47 }) as DOMRect;
    rerender(<Footer show />);
    footer.getBoundingClientRect = () => ({ height: 132 }) as DOMRect; // a child grew on its own
    act(() => { observers.forEach((cb) => cb()); });
    setStatus('working');
    expect(footer.style.height).toBe('132px');
  } finally {
    globalThis.ResizeObserver = RO;
  }
});

// Review round 1 (2026-10-12): the same terminal view can switch threads without a remount; one
// thread's height must not hold another thread's footer.
test('a height measured for one thread is never held for another', () => {
  setStatus('idle', 'a');
  const { rerender } = render(<Footer show id="a" />);
  const footer = screen.getByTestId('turn-footer');
  footer.getBoundingClientRect = () => ({ height: 90 }) as DOMRect;
  rerender(<Footer show id="a" />);
  act(() => { useThreadStatus.setState({ byTerminal: { a: { threadStatus: 'idle' }, b: { threadStatus: 'working' } } } as any); });
  rerender(<Footer show={false} id="b" />);
  expect(footer.style.height).toBe('');
  expect(footer.style.minHeight).toBe('');
});
