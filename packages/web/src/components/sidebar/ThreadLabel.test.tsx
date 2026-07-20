import React from 'react';
import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ThreadLabel } from './ThreadLabel';
import { useTabs } from '../../stores/tabs';

const NOW = new Date('2026-07-19T12:00:00.000Z').getTime();
const tab = { id: 't1', sessionId: 's1', label: 'Fix login bug', labelSource: 'auto' } as any;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  useTabs.setState({ autoNamed: {} } as any);
});
afterEach(() => {
  // restoreAllMocks() BEFORE useRealTimers(): a spy installed on setTimeout/clearTimeout while
  // fake timers are active (see the unmount test) captures the FAKE implementation as "original".
  // Restoring mocks after switching back to real timers would re-install that fake implementation
  // over the freshly-restored real one, breaking every later real-timer test in this file.
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (window as any).matchMedia;
});

function seed() {
  useTabs.setState({ autoNamed: { t1: { from: 'Claude Code', to: 'Fix login bug', at: NOW } } } as any);
}

test('renders the plain label when there is nothing to animate', () => {
  render(<ThreadLabel tab={tab} />);
  expect(screen.getByText('Fix login bug')).toBeInTheDocument();
  expect(document.querySelector('.dispatch-caret')).toBeNull();
});

test('backspaces the old label, then types the new one', () => {
  seed();
  const { container } = render(<ThreadLabel tab={tab} />);
  const text = () => container.querySelector('[data-testid="thread-label-text"]')!.textContent;

  expect(text()).toBe('Claude Code');
  act(() => { vi.advanceTimersByTime(25 * 3); });
  expect(text()).toBe('Claude C');              // three characters deleted

  act(() => { vi.advanceTimersByTime(25 * 8); });
  expect(text()).toBe('');                       // fully backspaced

  act(() => { vi.advanceTimersByTime(35 * 3); });
  expect(text()).toBe('Fix');                    // typing in

  act(() => { vi.advanceTimersByTime(35 * 40); });
  expect(text()).toBe('Fix login bug');          // settled on the truth
});

test('shows a caret during the animation and removes it after', () => {
  seed();
  const { container } = render(<ThreadLabel tab={tab} />);
  expect(container.querySelector('.dispatch-caret')).not.toBeNull();
  act(() => { vi.advanceTimersByTime(25 * 12 + 35 * 40); });
  expect(container.querySelector('.dispatch-caret')).toBeNull();
});

test('consumes the entry once — a re-render does not replay it', () => {
  seed();
  const { rerender, container } = render(<ThreadLabel tab={tab} />);
  act(() => { vi.advanceTimersByTime(25 * 12 + 35 * 40); });
  expect(useTabs.getState().autoNamed['t1']).toBeUndefined();
  rerender(<ThreadLabel tab={{ ...tab }} />);
  expect(container.querySelector('[data-testid="thread-label-text"]')!.textContent).toBe('Fix login bug');
  expect(container.querySelector('.dispatch-caret')).toBeNull();
});

test('reduced motion consumes the entry but swaps instantly', () => {
  (window as any).matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  seed();
  const { container } = render(<ThreadLabel tab={tab} />);
  expect(container.querySelector('[data-testid="thread-label-text"]')!.textContent).toBe('Fix login bug');
  expect(container.querySelector('.dispatch-caret')).toBeNull();
  expect(useTabs.getState().autoNamed['t1']).toBeUndefined();
});

// ── Finding 2 ────────────────────────────────────────────────────────────
// consumedRef was keyed on `${tab.id}:${tab.label}` only. Reduced motion consumes the entry
// instantly (no timers) rather than animating it. Toggling the OS reduced-motion preference
// OFF afterward re-runs the layout effect with a tab.id/tab.label that hasn't changed, so the
// old key still matched and handed back the already-consumed entry — except this time
// `reduced` is false, so the `!entry || reduced` guard no longer short-circuits it, and the
// finished rename replays as a full typewriter animation. Keying on `reduced` too fixes it:
// the second run looks like a fresh identity, falls through to consumeAutoName() again, and
// gets null (already consumed) instead of a replay.
test('Finding 2: toggling reduced-motion off after a reduced-motion swap has finished does not replay the animation', () => {
  // A faithful MediaQueryList fake: usePrefersReducedMotion reads `.matches` and subscribes via
  // addEventListener('change', ...) — capture that handler so the test can fire a REAL toggle,
  // the same way the hook would see the OS preference change mid-session.
  let matches = true;
  let onChange: (() => void) | null = null;
  const mq = {
    get matches() { return matches; },
    addEventListener: (_event: string, cb: () => void) => { onChange = cb; },
    removeEventListener: vi.fn(),
  };
  (window as any).matchMedia = vi.fn(() => mq);

  seed();
  const { container } = render(<ThreadLabel tab={tab} />);
  const text = () => container.querySelector('[data-testid="thread-label-text"]')!.textContent;

  // Reduced motion: instant swap, entry consumed, no caret, no pending timers.
  expect(text()).toBe('Fix login bug');
  expect(container.querySelector('.dispatch-caret')).toBeNull();
  expect(useTabs.getState().autoNamed['t1']).toBeUndefined();

  // OS preference flips off mid-session — usePrefersReducedMotion's own change listener fires,
  // flipping `reduced` to false and re-rendering ThreadLabel with the SAME tab.id/tab.label.
  matches = false;
  act(() => { onChange!(); });

  // Must still show the plain, settled label — not restart backspacing it.
  expect(text()).toBe('Fix login bug');
  expect(container.querySelector('.dispatch-caret')).toBeNull();

  // And no del/type timers were armed as a result of the toggle.
  act(() => { vi.advanceTimersByTime(25 * 12 + 35 * 40); });
  expect(text()).toBe('Fix login bug');
  expect(container.querySelector('.dispatch-caret')).toBeNull();
});

test('a user rename mid-animation cancels it and shows the new truth', () => {
  seed();
  const { rerender, container } = render(<ThreadLabel tab={tab} />);
  act(() => { vi.advanceTimersByTime(25 * 3); });
  rerender(<ThreadLabel tab={{ ...tab, label: 'My name', labelSource: 'user' }} />);
  expect(container.querySelector('[data-testid="thread-label-text"]')!.textContent).toBe('My name');
  expect(container.querySelector('.dispatch-caret')).toBeNull();
});

test('exposes the true label to assistive tech while animating', () => {
  seed();
  render(<ThreadLabel tab={tab} />);
  expect(screen.getByLabelText('Fix login bug')).toBeInTheDocument();
});

test('unmounting mid-animation clears the exact pending timer, and no further del/type step is ever scheduled', () => {
  // Finding 4: `expect(clear.mock.calls.length).toBeGreaterThan(calls)` passes on ANY clearTimeout
  // call anywhere (e.g. an unrelated cleanup elsewhere in the tree), not specifically on this
  // animation's own pending timer. Assert the exact handle instead, and that the del/type chain
  // truly stops (no more of its 25ms/35ms timeouts get scheduled) rather than just "some timer".
  seed();
  const setSpy = vi.spyOn(globalThis, 'setTimeout');
  const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
  const { unmount } = render(<ThreadLabel tab={tab} />);
  act(() => { vi.advanceTimersByTime(25 * 3); });

  // Find this animation's most recently scheduled timer (its delay is always 25 or 35ms) — that's
  // the one still outstanding when we unmount.
  let lastOursIdx = -1;
  setSpy.mock.calls.forEach((args, i) => { if (args[1] === 25 || args[1] === 35) lastOursIdx = i; });
  expect(lastOursIdx).toBeGreaterThanOrEqual(0);
  const pendingHandle = setSpy.mock.results[lastOursIdx]!.value;

  unmount();

  expect(clearSpy).toHaveBeenCalledWith(pendingHandle); // the SPECIFIC pending timer was cleared

  const scheduledAtUnmount = setSpy.mock.calls.length;
  act(() => { vi.advanceTimersByTime(5000); });
  const scheduledAfter = setSpy.mock.calls.slice(scheduledAtUnmount).filter(([, ms]) => ms === 25 || ms === 35);
  expect(scheduledAfter).toHaveLength(0); // the chain never re-arms after unmount
});

// ── Finding 1 ────────────────────────────────────────────────────────────
// The first painted frame of an animating label must already be the OLD
// label. RTL's render() wraps everything in act(), which flushes effects
// before ever handing control back to the test, so it cannot observe the
// pre-effect commit. Use react-dom/client directly (mirroring the reviewer's
// repro): flushSync forces the DOM commit (and any useLayoutEffect) to happen
// synchronously while still leaving a deferred useEffect unflushed, which is
// exactly the boundary this finding is about.
test('Finding 1: the first painted frame is the OLD label — the final label never flashes first', async () => {
  vi.useRealTimers(); // raw createRoot commit/effect timing must not be faked
  // Seed with a real-clock timestamp (not the fixed fake-time NOW): consumeAutoName
  // treats entries older than AUTO_NAME_TTL_MS as stale relative to Date.now(), which
  // is real wall-clock time now that fake timers are off.
  useTabs.setState({ autoNamed: { t1: { from: 'Claude Code', to: 'Fix login bug', at: Date.now() } } } as any);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const text = () => host.querySelector('[data-testid="thread-label-text"]')?.textContent;

  flushSync(() => { root.render(<ThreadLabel tab={tab} />); });
  // This is the very first browser-visible paint. If the bug is present, `typed`
  // is still null at this point and the component renders tab.label — the FINAL
  // name — because the store already applied the rename before this render.
  expect(text()).toBe('Claude Code');
  expect(text()).not.toBe('Fix login bug');

  // Let any deferred (useEffect) work the browser would run after paint flush.
  await new Promise((r) => setTimeout(r, 0));
  // Must not have snapped forward to the final label as part of that flush —
  // the buggy version paints the final label first, then reverts to this same
  // old label only once the deferred effect runs, which reads as a flash.
  expect(text()).not.toBe('Fix login bug');

  // Let the whole backspace+type animation finish in real time and confirm it
  // still settles correctly once the fix's synchronous kickoff has run.
  await new Promise((r) => setTimeout(r, 900));
  expect(text()).toBe('Fix login bug');

  root.unmount();
  document.body.removeChild(host);
});

// ── Finding 2 ────────────────────────────────────────────────────────────
// React.StrictMode double-invokes effects in development (mount -> cleanup ->
// mount) without re-running render or destroying refs/state. consumeAutoName
// is consume-once, so the naive version has the first simulated mount eat the
// entry and start timers, the simulated cleanup cancel them, and the second
// (real) mount find nothing left — no animation ever plays under `pnpm dev`.
test('Finding 2: survives React.StrictMode double-invoked effects — the animation still plays', () => {
  seed();
  const { container } = render(
    <React.StrictMode>
      <ThreadLabel tab={tab} />
    </React.StrictMode>,
  );
  const text = () => container.querySelector('[data-testid="thread-label-text"]')!.textContent;

  act(() => { vi.advanceTimersByTime(25 * 3); });
  expect(text()).toBe('Claude C'); // backspacing must actually be in progress, not skipped

  act(() => { vi.advanceTimersByTime(25 * 8); });
  expect(text()).toBe('');

  act(() => { vi.advanceTimersByTime(35 * 3); });
  expect(text()).toBe('Fix');

  act(() => { vi.advanceTimersByTime(35 * 40); });
  expect(text()).toBe('Fix login bug');
});
