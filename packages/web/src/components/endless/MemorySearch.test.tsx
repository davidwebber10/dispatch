import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemorySearch } from './MemorySearch';
import { useEndless } from '../../stores/endless';
import { api } from '../../api/client';

let saved: ReturnType<typeof useEndless.getState>;
beforeEach(() => {
  vi.restoreAllMocks();
  saved = useEndless.getState();
  useEndless.setState({ filter: 's1' });
});
afterEach(() => { useEndless.setState(saved, true); });

const box = () => screen.getByRole('textbox', { name: 'Search memory' });
const hit = (i: number, snippet: string) => ({ i, kind: 'user' as const, project: 's1', projectName: 'salsify', createdAt: Date.UTC(2026, 9, 1), snippet });

describe('MemorySearch', () => {
  it('searches the active project and opens the chat at a result', async () => {
    const search = vi.spyOn(api, 'endlessSearch').mockResolvedValue({ results: [hit(42, 'deploy the \u0002parquet\u0003 exporter')] });
    const openAt = vi.spyOn(useEndless.getState(), 'openAt').mockResolvedValue();
    render(<MemorySearch />);
    fireEvent.change(box(), { target: { value: 'parquet' } });
    await waitFor(() => expect(search).toHaveBeenCalledWith('parquet', 's1'));
    const option = await screen.findByRole('option');
    expect(option).toHaveTextContent('salsify');
    expect(option.querySelector('mark')).toHaveTextContent('parquet');
    fireEvent.click(option);
    expect(openAt).toHaveBeenCalledWith(42);
  });

  it('says so when nothing matches', async () => {
    vi.spyOn(api, 'endlessSearch').mockResolvedValue({ results: [] });
    render(<MemorySearch />);
    fireEvent.change(box(), { target: { value: 'zzz' } });
    expect(await screen.findByText('No matches')).toBeInTheDocument();
  });

  it('says search is unavailable on a 503 and does not crash', async () => {
    vi.spyOn(api, 'endlessSearch').mockRejectedValue(new Error('GET /api/endless/search failed: 503'));
    render(<MemorySearch />);
    fireEvent.change(box(), { target: { value: 'x' } });
    expect(await screen.findByText('Search is unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No matches')).toBeNull();
  });

  it('drops a stale response that arrives after a newer query', async () => {
    let resolveOld: (v: { results: ReturnType<typeof hit>[] }) => void = () => {};
    const search = vi.spyOn(api, 'endlessSearch')
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }))
      .mockResolvedValueOnce({ results: [hit(2, 'new \u0002result\u0003')] });
    render(<MemorySearch />);
    fireEvent.change(box(), { target: { value: 'old' } });
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    fireEvent.change(box(), { target: { value: 'new' } });
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('option')).toHaveTextContent('new');
    resolveOld({ results: [hit(1, 'old stale')] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.queryByText(/old stale/)).toBeNull();
  });
});
