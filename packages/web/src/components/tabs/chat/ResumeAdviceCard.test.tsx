import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResumeAdviceCard, formatAge } from './ResumeAdviceCard';

describe('formatAge', () => {
  it('renders minutes under an hour', () => { expect(formatAge(45)).toBe('45m'); });
  it('renders whole hours without minutes', () => { expect(formatAge(120)).toBe('2h'); });
  it('renders hours and minutes', () => { expect(formatAge(150)).toBe('2h 30m'); });
  it('renders days and hours', () => { expect(formatAge(4560)).toBe('3d 4h'); });
  it('renders whole days without hours', () => { expect(formatAge(4320)).toBe('3d'); });
});

describe('ResumeAdviceCard', () => {
  const props = { ageMinutes: 4560, contextTokens: 134_000, onSummarize: vi.fn(), onFull: vi.fn(), onNever: vi.fn() };

  it('states the session age and size', () => {
    render(<ResumeAdviceCard {...props} />);
    expect(screen.getByText(/3d 4h old and 134,000 tokens/)).toBeTruthy();
  });

  // Each button is checked in ISOLATION — clicking all three and then asserting each spy
  // saw one call would pass even if two handlers were swapped, since the counts still add
  // up. Rendering fresh per case is what actually pins button→callback wiring.
  it.each([
    ['resume from summary', 'onSummarize'],
    ['resume full session', 'onFull'],
    ["don't ask again", 'onNever'],
  ] as const)('fires only %s\'s own callback', (label, expected) => {
    const spies = { onSummarize: vi.fn(), onFull: vi.fn(), onNever: vi.fn() };
    render(<ResumeAdviceCard {...props} {...spies} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(label, 'i') }));
    expect(spies[expected]).toHaveBeenCalledOnce();
    for (const [name, spy] of Object.entries(spies)) {
      if (name !== expected) expect(spy).not.toHaveBeenCalled();
    }
  });
});
