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

  it('fires the matching callback for each action', () => {
    const onSummarize = vi.fn(), onFull = vi.fn(), onNever = vi.fn();
    render(<ResumeAdviceCard {...props} onSummarize={onSummarize} onFull={onFull} onNever={onNever} />);
    fireEvent.click(screen.getByRole('button', { name: /resume from summary/i }));
    fireEvent.click(screen.getByRole('button', { name: /resume full session/i }));
    fireEvent.click(screen.getByRole('button', { name: /don't ask again/i }));
    expect(onSummarize).toHaveBeenCalledOnce();
    expect(onFull).toHaveBeenCalledOnce();
    expect(onNever).toHaveBeenCalledOnce();
  });
});
