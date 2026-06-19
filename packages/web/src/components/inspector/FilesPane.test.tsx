import { render, screen } from '@testing-library/react';
import { vi, beforeEach, afterEach, test, expect } from 'vitest';
import { FilesPane } from './FilesPane';
import { api } from '../../api/client';

beforeEach(() => {
  vi.spyOn(api, 'listFiles').mockResolvedValue([
    { name: 'README.md', isDirectory: false, path: 'README.md' },
    { name: 'src', isDirectory: true, path: 'src' },
  ]);
});
afterEach(() => vi.restoreAllMocks());

test('lists directory entries for the project, folders first', async () => {
  render(<FilesPane projectId="s1" onOpenFile={() => {}} />);
  expect(await screen.findByText(/src/)).toBeInTheDocument();
  expect(screen.getByText(/README\.md/)).toBeInTheDocument();
  expect(api.listFiles).toHaveBeenCalledWith('s1', '.');
});
