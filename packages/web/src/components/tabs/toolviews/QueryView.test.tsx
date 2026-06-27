import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { getToolView, parseToolInput } from './registry';
import { QueryView } from './QueryView';

test('getToolView matches a tool whose input has a sql/query/statement field', () => {
  expect(getToolView('mcp__databricks__databricks_query', { query: 'SELECT 1' })).not.toBeNull();
  expect(getToolView('run_shopifyql_query', { query: 'FROM sales SHOW x' })).not.toBeNull();
  expect(getToolView('SomeTool', { statement: 'SELECT 2' })).not.toBeNull();
});

test('getToolView returns null when there is no query field and no other match', () => {
  expect(getToolView('mcp__acumatica__acumatica_search_orders', { filter: 'x' })).toBeNull();
});

test('parseToolInput safely returns null on junk', () => {
  expect(parseToolInput('not json')).toBeNull();
  expect(parseToolInput(undefined)).toBeNull();
});

test('QueryView renders the SQL and a result table', () => {
  const tool = { kind: 'tool', toolName: 'mcp__databricks__databricks_query', toolInput: JSON.stringify({ query: 'SELECT id, name FROM t' }) } as any;
  const result = { kind: 'tool-result', text: '[{"id":1,"name":"a"}]' } as any;
  const { container } = render(<QueryView tool={tool} result={result} />);
  expect(container.textContent).toContain('SELECT id, name FROM t'); // syntax-highlighted across spans
  expect(screen.getByText('name')).toBeInTheDocument(); // a column header
  expect(screen.getByText('a')).toBeInTheDocument();    // a cell
});

test('QueryView falls back to raw result text when not tabular', () => {
  const tool = { kind: 'tool', toolName: 'x', toolInput: JSON.stringify({ query: 'SELECT 1' }) } as any;
  const result = { kind: 'tool-result', text: 'Query returned no rows.' } as any;
  render(<QueryView tool={tool} result={result} />);
  expect(screen.getByText('Query returned no rows.')).toBeInTheDocument();
});
