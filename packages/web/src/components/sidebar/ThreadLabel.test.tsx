import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ThreadLabel } from './ThreadLabel';
import { useTabs } from '../../stores/tabs';

const NOW = new Date('2026-07-19T12:00:00.000Z').getTime();
const tab = { id: 't1', sessionId: 's1', label: 'Fix login bug', labelSource: 'auto' } as any;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  useTabs.setState({ autoNamed: {} } as any);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete (window as any).matchMedia; });

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

test('unmounting mid-animation clears its timer and stops rendering', () => {
  seed();
  const clear = vi.spyOn(globalThis, 'clearTimeout');
  const { unmount, container } = render(<ThreadLabel tab={tab} />);
  act(() => { vi.advanceTimersByTime(25 * 3); });
  const calls = clear.mock.calls.length;
  unmount();
  expect(clear.mock.calls.length).toBeGreaterThan(calls); // cleanup ran
  act(() => { vi.advanceTimersByTime(5000); });
  expect(container.querySelector('[data-testid="thread-label-text"]')).toBeNull();
});
