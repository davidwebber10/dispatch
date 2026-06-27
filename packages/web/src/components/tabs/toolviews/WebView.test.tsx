import { render, screen } from '@testing-library/react';
import { test, expect } from 'vitest';
import { getToolView } from './registry';
import { WebView } from './WebView';

test('getToolView matches WebFetch and WebSearch', () => {
  expect(getToolView('WebFetch', { url: 'https://x.com' })).not.toBeNull();
  expect(getToolView('WebSearch', { query: 'hello' })).not.toBeNull();
});

test('WebView shows the URL and a result snippet for WebFetch', () => {
  const tool = { kind: 'tool', toolName: 'WebFetch', toolInput: JSON.stringify({ url: 'https://example.com/x', prompt: 'summarize' }) } as any;
  const result = { kind: 'tool-result', text: 'A short summary.' } as any;
  render(<WebView tool={tool} result={result} />);
  expect(screen.getByText('https://example.com/x')).toBeInTheDocument();
  expect(screen.getByText(/A short summary\./)).toBeInTheDocument();
});

test('WebView shows the query for WebSearch', () => {
  const tool = { kind: 'tool', toolName: 'WebSearch', toolInput: JSON.stringify({ query: 'best widgets' }) } as any;
  render(<WebView tool={tool} />);
  expect(screen.getByText('best widgets')).toBeInTheDocument();
});

test('WebSearch is matched as Web (not the SQL query view) even though it has a query field', () => {
  const view = getToolView('WebSearch', { query: 'best widgets' });
  const tool = { kind: 'tool', toolName: 'WebSearch', toolInput: JSON.stringify({ query: 'best widgets' }) } as any;
  render(<>{view!.expanded(tool, undefined)}</>);
  // WebView renders the query as plain text; the SQL QueryView would wrap it in a highlighted <pre>.
  expect(screen.getByText('best widgets')).toBeInTheDocument();
});
