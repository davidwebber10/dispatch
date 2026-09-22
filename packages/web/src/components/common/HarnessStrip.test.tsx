import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HarnessStrip } from './HarnessStrip';

const HARNESSES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];

describe('HarnessStrip', () => {
  it('renders a pressed state on the selected harness and fires onSelect', () => {
    const onSelect = vi.fn();
    render(<HarnessStrip harnesses={HARNESSES} value="claude" onSelect={onSelect} mobile={false} />);
    expect(screen.getByRole('button', { name: /Claude Code/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }));
    expect(onSelect).toHaveBeenCalledWith('codex');
  });

  it('dims and tags an unavailable harness with Install', () => {
    render(<HarnessStrip harnesses={HARNESSES} value="claude" onSelect={() => {}} isAvailable={(id) => id !== 'codex'} mobile={false} />);
    expect(screen.getByText('Install')).toBeTruthy();
  });

  it('does not crash on an unknown harness id', () => {
    render(<HarnessStrip harnesses={[{ id: 'future', label: 'Future' }]} value="future" onSelect={() => {}} mobile />);
    expect(screen.getByRole('button', { name: /Future/ })).toBeTruthy();
  });
});
