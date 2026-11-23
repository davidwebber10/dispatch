import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, renderHook } from '@testing-library/react';
import { PillComposer } from './PillComposer';
import { useActivationSignal } from './useActivationSignal';
import { useTabs } from '../../stores/tabs';

// Owner, 2026-11-16: "when I click a tab, is it possible to highlight the composer? in both Pretty and
// CLI, but just on desktop, not mobile". A tab that becomes the open one focuses its composer and gives
// its ring one pulse; the phone does nothing (a focus there opens the keyboard).

const dictation = () => ({ state: 'idle', error: null, progress: {}, recordingId: null, start: vi.fn(), retry: vi.fn(), insert: vi.fn(), stop: vi.fn(), cancel: vi.fn(), reset: vi.fn(), getAnalyser: () => null }) as never;
const base = { value: '', onChange: vi.fn(), onSend: vi.fn(), canSend: false, placeholder: 'Message…', onAddFile: vi.fn(), sttConfigured: true, dictation: dictation() };
const phone = (on: boolean) => vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ matches: on && /max-width/.test(q), media: q, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }) as any);
const frames = async () => { await act(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))); }); };

beforeEach(() => { useTabs.setState({ activeTabId: null } as any); });
afterEach(() => { vi.restoreAllMocks(); });

describe('useActivationSignal', () => {
  it('counts each time the thread becomes the open tab, on the desktop', () => {
    phone(false);
    const { result } = renderHook(() => useActivationSignal('t1'));
    expect(result.current).toBe(0);
    act(() => { useTabs.setState({ activeTabId: 't1' } as any); });
    expect(result.current).toBe(1);
    act(() => { useTabs.setState({ activeTabId: 't2' } as any); });
    act(() => { useTabs.setState({ activeTabId: 't1' } as any); });
    expect(result.current).toBe(2);
  });

  it('stays 0 on a phone', () => {
    phone(true);
    const { result } = renderHook(() => useActivationSignal('t1'));
    act(() => { useTabs.setState({ activeTabId: 't1' } as any); });
    expect(result.current).toBe(0);
  });
});

describe('PillComposer focusSignal', () => {
  it('a new signal focuses the text box and pulses the ring', async () => {
    const { rerender } = render(<PillComposer {...base} focusSignal={0} />);
    const box = screen.getByRole('textbox');
    expect(document.activeElement).not.toBe(box);
    rerender(<PillComposer {...base} focusSignal={1} />);
    await frames();
    expect(document.activeElement).toBe(box);
    expect(screen.getByTestId('pill-composer').getAttribute('data-flash')).toBe('true');
  });

  it('a signal of 0 does nothing', async () => {
    render(<PillComposer {...base} focusSignal={0} />);
    await frames();
    expect(document.activeElement).not.toBe(screen.getByRole('textbox'));
    expect(screen.getByTestId('pill-composer').getAttribute('data-flash')).toBeNull();
  });
});

// Owner, 2026-11-23: after a dictation the text comes back and the focus is lost; the owner wants to keep
// typing at the end of the returned text without a click. The text box is unmounted while the mic records
// (the recording bar takes its place), so the new box must take the focus back itself.
describe('PillComposer after a dictation', () => {
  const rec = (state: string) => ({ ...(dictation() as object), state }) as never;

  it('the text box takes the focus back, with the caret at the end of the text', async () => {
    phone(false);
    const { rerender } = render(<PillComposer {...base} dictation={rec('transcribing')} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    rerender(<PillComposer {...base} value="typed before and the spoken words" dictation={rec('idle')} />);
    await frames();
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(box.value.length);
    expect(box.selectionEnd).toBe(box.value.length);
  });

  it('a cancelled recording also gives the focus back to the text box', async () => {
    phone(false);
    const { rerender } = render(<PillComposer {...base} dictation={rec('recording')} />);
    rerender(<PillComposer {...base} dictation={rec('idle')} />);
    await frames();
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
  });

  it('a failed transcription leaves the focus alone (the error line has the Retry)', async () => {
    phone(false);
    const { rerender } = render(<PillComposer {...base} dictation={rec('transcribing')} />);
    rerender(<PillComposer {...base} dictation={rec('error')} />);
    await frames();
    expect(document.activeElement).not.toBe(screen.getByRole('textbox'));
  });

  it('a field the user moved to keeps the focus (the command palette opened while the text was on its way)', async () => {
    phone(false);
    const other = document.createElement('input');
    document.body.appendChild(other);
    const { rerender } = render(<PillComposer {...base} dictation={rec('transcribing')} />);
    other.focus();
    rerender(<PillComposer {...base} value="spoken" dictation={rec('idle')} />);
    await frames();
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it('the way back from a failure (a transcript inserted from Recordings, a working Retry) gives the focus back', async () => {
    phone(false);
    const { rerender } = render(<PillComposer {...base} dictation={rec('error')} />);
    rerender(<PillComposer {...base} value="from a saved recording" dictation={rec('idle')} />);
    await frames();
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(box.value.length);
  });

  it('a first render does not take the focus', async () => {
    phone(false);
    render(<PillComposer {...base} value="draft" dictation={rec('idle')} />);
    await frames();
    expect(document.activeElement).not.toBe(screen.getByRole('textbox'));
  });

  it('on a phone it does nothing (a focus there opens the keyboard)', async () => {
    phone(true);
    const { rerender } = render(<PillComposer {...base} dictation={rec('transcribing')} />);
    rerender(<PillComposer {...base} value="spoken" dictation={rec('idle')} />);
    await frames();
    expect(document.activeElement).not.toBe(screen.getByRole('textbox'));
  });
});
