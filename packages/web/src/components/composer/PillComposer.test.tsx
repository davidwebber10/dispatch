import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PillComposer } from './PillComposer';

const dictation = (over: Record<string, unknown> = {}) => ({
  state: 'idle', error: null, start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), reset: vi.fn(), getAnalyser: () => null, ...over,
}) as never;

const base = { value: '', onChange: vi.fn(), onSend: vi.fn(), canSend: false, placeholder: 'Message…', onAddFile: vi.fn(), sttConfigured: true };

describe('PillComposer', () => {
  it('a dictation error is a line above the box, and the text box stays usable', () => {
    const d = dictation({ state: 'error', error: 'Microphone access is blocked. Allow it in Settings → Dispatch → Microphone, then retry.' });
    render(<PillComposer {...base} dictation={d} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Microphone access is blocked');
    expect(screen.getByTestId('pill-composer')).not.toContainElement(alert);
    expect(screen.getByPlaceholderText('Message…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect((d as { start: ReturnType<typeof vi.fn> }).start).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect((d as { reset: ReturnType<typeof vi.fn> }).reset).toHaveBeenCalled();
  });

  it('the send key is the theme accent once there is something to send', () => {
    render(<PillComposer {...base} value="hi" canSend dictation={dictation()} />);
    expect(screen.getByRole('button', { name: 'Send' }).style.background).toBe('var(--color-accent)');
  });

  it('once there is text it gets its own full-width line above the + / mic / send row', () => {
    const { rerender } = render(<PillComposer {...base} dictation={dictation()} />);
    const box = screen.getByTestId('pill-composer');
    expect(box.getAttribute('data-stacked')).toBeNull();
    expect(box.style.gridTemplateAreas).toBe('"plus text mic send"');
    const ta = screen.getByPlaceholderText('Message…');
    rerender(<PillComposer {...base} value="hello" canSend dictation={dictation()} />);
    expect(box.getAttribute('data-stacked')).toBe('true');
    expect(box.style.gridTemplateAreas).toBe('"text text text text" "plus . mic send"');
    expect(screen.getByPlaceholderText('Message…')).toBe(ta); // the same box: typing keeps its focus
  });
});

