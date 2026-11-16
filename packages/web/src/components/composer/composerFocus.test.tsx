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
