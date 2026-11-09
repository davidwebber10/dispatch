// W2-I: the owner's bubble shows before the daemon's echo. A refused POST marks it and offers Retry.
import { render, screen, fireEvent } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { UserBubble } from './leaves';

test('a bubble that waits for the daemon is dimmed and says so to a screen reader', () => {
  render(<UserBubble text="hello" sendState="sending" />);
  const b = screen.getByTestId('user-bubble');
  expect(b.getAttribute('data-send-state')).toBe('sending');
  expect(b.style.opacity).toBe('0.72');
  expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
});

test('a failed bubble says Not sent and Retry calls back', () => {
  const onRetry = vi.fn();
  render(<UserBubble text="hello" sendState="failed" onRetry={onRetry} />);
  expect(screen.getByText('Not sent')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('a failed bubble with no retry handler (a surface that cannot send) shows the mark only', () => {
  render(<UserBubble text="hello" sendState="failed" />);
  expect(screen.getByText('Not sent')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});

test('an ordinary bubble has no mark and full opacity', () => {
  render(<UserBubble text="hello" />);
  expect(screen.getByTestId('user-bubble').style.opacity).toBe('');
  expect(screen.queryByText('Not sent')).toBeNull();
});
