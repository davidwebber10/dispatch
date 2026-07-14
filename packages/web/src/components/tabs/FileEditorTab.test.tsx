import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileEditorTab } from './FileEditorTab';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';

function tab(path: string): Terminal {
  return { id: 't1', sessionId: 's1', type: 'file', label: path, config: { path } } as unknown as Terminal;
}

describe('FileEditorTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'writeFile').mockResolvedValue({ ok: true, path: 'x' } as never);
  });

  it('shows a Table|Raw toggle and the grid for a .csv', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'name,qty\napples,3\n', path: 'd.csv' });
    render(<FileEditorTab terminal={tab('d.csv')} />);

    expect(await screen.findByText('table')).toBeInTheDocument();
    expect(screen.getByText('raw')).toBeInTheDocument();
    expect(await screen.findByText('apples')).toBeInTheDocument();  // the grid, not raw text
  });

  it('keeps View|Edit for markdown and offers no toggle for code', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: '# hi', path: 'a.md' });
    const { unmount } = render(<FileEditorTab terminal={tab('a.md')} />);
    expect(await screen.findByText('view')).toBeInTheDocument();
    expect(screen.queryByText('table')).toBeNull();
    unmount();

    vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'const x = 1', path: 'a.ts' });
    render(<FileEditorTab terminal={tab('a.ts')} />);
    await waitFor(() => expect(screen.queryByText('view')).toBeNull());
    expect(screen.queryByText('table')).toBeNull();
  });

  it('a grid edit marks the file dirty and saves the serialized CSV', async () => {
    vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'name,qty\napples,3\n', path: 'd.csv' });
    render(<FileEditorTab terminal={tab('d.csv')} />);

    fireEvent.doubleClick(await screen.findByText('apples'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'bananas' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('● unsaved')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(api.writeFile).toHaveBeenCalledWith('s1', 'd.csv', 'name,qty\nbananas,3\n'),
    );
  });
});
