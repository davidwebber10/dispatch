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
});
