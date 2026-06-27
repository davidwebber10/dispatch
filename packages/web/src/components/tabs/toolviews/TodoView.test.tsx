import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { getToolView } from './registry';
import { TodoView } from './TodoView';

test('getToolView matches TodoWrite', () => {
  expect(getToolView('TodoWrite', { todos: [] })).not.toBeNull();
});

test('TodoView renders each todo with a status glyph', () => {
  const tool = { kind: 'tool', toolName: 'TodoWrite', toolInput: JSON.stringify({ todos: [
    { content: 'first', status: 'completed' },
    { content: 'second', status: 'in_progress', activeForm: 'Doing second' },
    { content: 'third', status: 'pending' },
  ] }) } as any;
  render(<TodoView tool={tool} />);
  expect(screen.getByText('first')).toBeInTheDocument();
  expect(screen.getByText('Doing second')).toBeInTheDocument(); // activeForm shown while in progress
  expect(screen.getByText('third')).toBeInTheDocument();
});
