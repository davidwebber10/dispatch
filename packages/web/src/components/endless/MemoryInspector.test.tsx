import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryInspector } from './MemoryInspector';
import { api } from '../../api/client';

const RENDERED = '<chat>\n0+4|user: set up the repo\n4+1|(not summarized yet: zoom it)\n</chat>';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'endlessView').mockResolvedValue({ bytes: 2048, rendered: RENDERED, lines: [
    { name: '0+4', l: 2, i: 0, text: 'user: set up\nthe repo' },
    { name: '4+1', l: 0, i: 4, text: null },
  ] });
  vi.spyOn(api, 'endlessInstructions').mockResolvedValue({ text: 'I am David.' });
});

describe('MemoryInspector', () => {
  it('shows the server-rendered view verbatim with its line count and size', async () => {
    render(<MemoryInspector open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('memory-view').textContent).toBe(RENDERED));
    expect(screen.getByText(/2 lines · 2\.0 KB/)).toBeInTheDocument();
  });

  it('says memory is unavailable when the view fails, without crashing', async () => {
    vi.spyOn(api, 'endlessView').mockRejectedValue(new Error('GET /api/endless/view failed: 503'));
    render(<MemoryInspector open onClose={() => {}} />);
    expect(await screen.findByText('Memory is unavailable.')).toBeInTheDocument();
    expect(screen.queryByTestId('memory-view')).toBeNull();
  });

  it('edits the Chat instructions', async () => {
    const save = vi.spyOn(api, 'setEndlessInstructions').mockResolvedValue({ ok: true });
    render(<MemoryInspector open onClose={() => {}} />);
    const box = await screen.findByRole('textbox', { name: 'Chat instructions' });
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe('I am David.'));
    fireEvent.change(box, { target: { value: 'I am David. Be brief.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('I am David. Be brief.'));
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeInTheDocument();
  });

  it('disables the textarea and Save while the instructions load, and when the load fails', async () => {
    vi.spyOn(api, 'endlessInstructions').mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<MemoryInspector open onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Save instructions' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Chat instructions' })).toBeDisabled();
    unmount();
    vi.spyOn(api, 'endlessInstructions').mockRejectedValue(new Error('503'));
    const save = vi.spyOn(api, 'setEndlessInstructions').mockResolvedValue({ ok: true });
    render(<MemoryInspector open onClose={() => {}} />);
    expect(await screen.findByText('Instructions could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save instructions' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    expect(save).not.toHaveBeenCalled();
  });

  it('shows "Could not save" when the save fails', async () => {
    vi.spyOn(api, 'setEndlessInstructions').mockRejectedValue(new Error('500'));
    render(<MemoryInspector open onClose={() => {}} />);
    const box = await screen.findByRole('textbox', { name: 'Chat instructions' });
    await waitFor(() => expect(box).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    expect(await screen.findByText('Could not save')).toBeInTheDocument();
  });

  it('clears the stale view on reopen and ignores an older response', async () => {
    let resolveOld: (v: any) => void = () => {};
    const spy = vi.spyOn(api, 'endlessView')
      .mockReturnValueOnce(new Promise((r) => { resolveOld = r; }))
      .mockResolvedValueOnce({ bytes: 1000, rendered: 'NEW', lines: [] });
    const { rerender } = render(<MemoryInspector open onClose={() => {}} />);
    rerender(<MemoryInspector open={false} onClose={() => {}} />);
    rerender(<MemoryInspector open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('memory-view').textContent).toBe('NEW'));
    resolveOld({ bytes: 5, rendered: 'OLD', lines: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('memory-view').textContent).toBe('NEW');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
