import { render, screen, fireEvent } from '@testing-library/react';
import { test, expect } from 'vitest';
import { ToolCall } from './ToolCall';

test('renders a generic tool with expandable Input/Output for an unmatched tool', () => {
  const tool = { kind: 'tool', toolName: 'Bash', toolTitle: 'Bash', toolInput: 'ls -la' } as any;
  const result = { kind: 'tool-result', text: 'file1\nfile2' } as any;
  render(<ToolCall tool={tool} result={result} />);
  expect(screen.getByText('Bash')).toBeInTheDocument();
  expect(screen.getByText('2 lines')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Bash'));
  expect(screen.getByText('Output')).toBeInTheDocument();
});

test('renders a rich query table for a matched query tool (no generic tabs)', () => {
  const tool = { kind: 'tool', toolName: 'mcp__databricks__databricks_query', toolTitle: 'databricks_query', toolInput: JSON.stringify({ query: 'SELECT id FROM t' }) } as any;
  const result = { kind: 'tool-result', text: '[{"id":1}]' } as any;
  const { container } = render(<ToolCall tool={tool} result={result} />);
  fireEvent.click(screen.getByText('databricks_query'));
  expect(container.textContent).toContain('SELECT id FROM t'); // syntax-highlighted across spans
  expect(screen.queryByText('Output')).not.toBeInTheDocument(); // rich body, not the generic tabs
});

test('shows the tool detail as a subject on the collapsed row', () => {
  const tool = { kind: 'tool', toolId: 'x1', toolName: 'Bash', toolTitle: 'Bash', toolDetail: 'pnpm test', toolInput: 'pnpm test' } as any;
  const result = { kind: 'tool-result', toolId: 'x1', text: 'ok\nok' } as any;
  render(<ToolCall tool={tool} result={result} />);
  expect(screen.getByText('pnpm test')).toBeTruthy();
});

test('renders the collapsed row without card chrome', () => {
  const tool = { kind: 'tool', toolId: 'x1', toolName: 'Bash', toolTitle: 'Bash', toolDetail: 'pnpm test', toolInput: 'pnpm test' } as any;
  const result = { kind: 'tool-result', toolId: 'x1', text: 'ok\nok' } as any;
  const { container } = render(<ToolCall tool={tool} result={result} />);
  const row = container.firstElementChild as HTMLElement;
  expect(row.style.border).toBe('');
  expect(row.style.background).toBe('');
});
