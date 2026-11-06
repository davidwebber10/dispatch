import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { PreviewSheet } from './PreviewSheet';
import { usePreviews } from '../../stores/previews';
import type { Preview } from '../../api/types';

const item = (id: string, seenAt: string | null): Preview => ({
  id, sessionId: 's1', sessionName: 'Alpha', terminalId: 't1', terminalLabel: 'Worker', title: `Preview ${id}`, note: null, text: null, files: [],
  createdAt: new Date().toISOString(), seenAt,
});

afterEach(() => { vi.restoreAllMocks(); act(() => { usePreviews.setState({ sheet: null, items: [] } as never); }); });

describe('<PreviewSheet>', () => {
  it('shows the unviewed dot while open, and marks everything seen only when it closes', () => {
    const markAllSeen = vi.spyOn(usePreviews.getState(), 'markAllSeen').mockResolvedValue(undefined as never);
    vi.spyOn(usePreviews.getState(), 'load').mockResolvedValue(undefined as never);
    act(() => { usePreviews.setState({ sheet: 's1', items: [item('a', null), item('b', '2026-11-01T00:00:00Z')], loaded: true } as never); });
    render(<PreviewSheet />);
    expect(screen.getAllByLabelText('New')).toHaveLength(1); // only the unviewed one
    expect(markAllSeen).not.toHaveBeenCalled();
    act(() => { usePreviews.getState().closeSheet(); });
    expect(markAllSeen).toHaveBeenCalledWith('s1');
  });
});
