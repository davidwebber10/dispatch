import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DictationControl } from './DictationControl';

function mk(overrides = {}) {
  return { state: 'recording', error: null, start: vi.fn(), cancel: vi.fn(), confirm: vi.fn(), reset: vi.fn(), getAnalyser: () => null, ...overrides } as any;
}

it('recording: ✓ calls confirm, ✕ calls cancel', () => {
  const d = mk();
  render(<DictationControl dictation={d} />);
  fireEvent.click(screen.getByLabelText(/confirm/i));
  expect(d.confirm).toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(/cancel/i));
  expect(d.cancel).toHaveBeenCalled();
});

it('error: shows message and Retry calls start', () => {
  const d = mk({ state: 'error', error: 'Microphone permission denied.' });
  render(<DictationControl dictation={d} />);
  expect(screen.getByText(/permission denied/i)).toBeInTheDocument();
  fireEvent.click(screen.getByText(/retry/i));
  expect(d.start).toHaveBeenCalled();
});
