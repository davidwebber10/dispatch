import { render, screen, waitFor } from '@testing-library/react';
import { vi, test, expect, beforeEach, afterEach } from 'vitest';

vi.mock('codemirror', () => ({
  EditorView: class { state = { doc: { toString: () => '' } }; destroy() {} static updateListener = { of: () => ({}) }; },
  basicSetup: [],
}));
vi.mock('@codemirror/state', () => ({ EditorState: { create: () => ({}) } }));
vi.mock('@codemirror/theme-one-dark', () => ({ oneDark: {} }));

import { FileEditorTab } from './FileEditorTab';
import { api } from '../../api/client';

beforeEach(() => { vi.spyOn(api, 'readFile').mockResolvedValue({ content: 'hello', path: 'src/a.ts' }); });
afterEach(() => vi.restoreAllMocks());

test('loads the file content and shows the path + save control', async () => {
  render(<FileEditorTab terminal={{ id: 't1', sessionId: 's1', type: 'file', label: 'a.ts', config: { path: 'src/a.ts' } } as any} />);
  await waitFor(() => expect(api.readFile).toHaveBeenCalledWith('s1', 'src/a.ts'));
  expect(screen.getByText('src/a.ts')).toBeInTheDocument();
  expect(screen.getByText('Save')).toBeInTheDocument();
});
