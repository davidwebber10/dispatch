import { render, screen } from '@testing-library/react';
import { vi, test, expect } from 'vitest';

vi.mock('@tiptap/react', () => ({
  useEditor: () => ({ getHTML: () => '<p>hi</p>' }),
  EditorContent: ({ editor }: any) => <div data-testid="notes-editor">{editor ? 'ready' : 'none'}</div>,
}));
vi.mock('@tiptap/starter-kit', () => ({ default: {} }));

import { NotesTab } from './NotesTab';

test('mounts a rich-text editor seeded from config html', () => {
  render(<NotesTab terminal={{ id: 't1', sessionId: 's1', type: 'notes', config: { html: '<p>hi</p>' } } as any} />);
  expect(screen.getByTestId('notes-editor')).toHaveTextContent('ready');
});
