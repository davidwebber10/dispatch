// The footer under a CLI thread's terminal (2026-10-12): while a turn runs it keeps the height it
// had when the turn began, so a submit does not resize the terminal (each resize makes Codex's
// inline TUI clear its scrollback and reprint about 1000 lines).
import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { TurnFooter } from './TurnFooter';
import { useThreadStatus } from '../../stores/threadStatus';

const setStatus = (threadStatus: string) => act(() => { useThreadStatus.setState({ byTerminal: { t1: { threadStatus } } } as any); });

beforeEach(() => { useThreadStatus.setState({ byTerminal: {} } as any); });
afterEach(() => { cleanup(); });

function Footer({ show }: { show: boolean }) {
  return <TurnFooter terminalId="t1">{show && <div data-testid="strip">asking you</div>}</TurnFooter>;
}

test('while a turn runs, the footer keeps the height it had when the turn began; it lets go when the turn settles', () => {
  setStatus('idle');
  const { rerender } = render(<Footer show />);
  const footer = screen.getByTestId('turn-footer');
  // The exact height, not offsetHeight: a rounded hold (131 for 131.6) still resizes the terminal by
  // a pixel, and xterm can measure its rows again on that resize (seen in the browser check).
  footer.getBoundingClientRect = () => ({ height: 64.5 }) as DOMRect;
  rerender(<Footer show />); // measured while settled
  expect(footer.style.minHeight).toBe('');

  setStatus('working');
  rerender(<Footer show={false} />); // the strip goes away as the turn starts
  expect(footer.style.minHeight).toBe('64.5px');

  setStatus('idle');
  rerender(<Footer show={false} />);
  expect(footer.style.minHeight).toBe('');
});

test('a footer that was empty when the turn began holds no height', () => {
  setStatus('idle');
  const { rerender } = render(<Footer show={false} />);
  setStatus('working');
  rerender(<Footer show={false} />);
  expect(screen.getByTestId('turn-footer').style.minHeight).toBe('');
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
    expect(footer.style.minHeight).toBe('132px');
  } finally {
    globalThis.ResizeObserver = RO;
  }
});
