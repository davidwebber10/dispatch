import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { getToolView } from './registry';
import { DiffView } from './DiffView';

test('getToolView matches Edit, MultiEdit, Write', () => {
  expect(getToolView('Edit', { old_string: 'a', new_string: 'b' })).not.toBeNull();
  expect(getToolView('MultiEdit', { edits: [] })).not.toBeNull();
  expect(getToolView('Write', { content: 'x' })).not.toBeNull();
});

test('DiffView shows removed and added lines for an Edit', () => {
  const tool = { kind: 'tool', toolName: 'Edit', toolFile: 'a.ts', toolInput: JSON.stringify({ old_string: 'const a = 1', new_string: 'const a = 2' }) } as any;
  render(<DiffView tool={tool} />);
  expect(screen.getByText('const a = 1')).toBeInTheDocument();
  expect(screen.getByText('const a = 2')).toBeInTheDocument();
});

test('DiffView shows file content for a Write', () => {
  const tool = { kind: 'tool', toolName: 'Write', toolFile: 'a.ts', toolInput: JSON.stringify({ content: 'hello world' }) } as any;
  render(<DiffView tool={tool} />);
  expect(screen.getByText(/hello world/)).toBeInTheDocument();
});
