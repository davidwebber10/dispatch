import { render, screen } from '@testing-library/react';
import { test, expect, beforeEach } from 'vitest';
import { TabActivityIndicator, GroupActivityIndicator } from './TabActivityIndicator';
import { useTabs } from '../../stores/tabs';
import type { Terminal } from '../../api/types';

const term = (over: Partial<Terminal>): Terminal => ({
  id: 't1', sessionId: 'p1', type: 'claude-code', label: 't', pid: null, externalId: null,
  workingDir: null, status: 'waiting', createdAt: '', config: {}, archivedAt: null, sortOrder: 0, ...over,
});

beforeEach(() => {
  useTabs.setState({
    byProject: { p1: [term({ id: 'w', status: 'working' }), term({ id: 'n', status: 'needs_input' }), term({ id: 'e', status: 'error' }), term({ id: 'i', status: 'waiting' })] },
    loading: {},
  });
});

test('spinner while the thread is working', () => {
  render(<TabActivityIndicator tabId="w" />);
  expect(screen.getByLabelText('loading')).toBeInTheDocument();
});

test('spinner while the tab content is still loading (transient flag)', () => {
  useTabs.setState({ loading: { i: true } });
  render(<TabActivityIndicator tabId="i" />);
  expect(screen.getByLabelText('loading')).toBeInTheDocument();
});

test('yellow dot when the thread needs input', () => {
  render(<TabActivityIndicator tabId="n" />);
  expect(screen.getByLabelText('status-needs_input')).toBeInTheDocument();
});

test('red dot on error', () => {
  render(<TabActivityIndicator tabId="e" />);
  expect(screen.getByLabelText('status-error')).toBeInTheDocument();
});

test('nothing when idle', () => {
  const { container } = render(<TabActivityIndicator tabId="i" />);
  expect(container).toBeEmptyDOMElement();
});

test('nothing for a tab with no terminal (file / virtual tabs)', () => {
  const { container } = render(<TabActivityIndicator tabId="dispatch:p1" />);
  expect(container).toBeEmptyDOMElement();
});

test('group rollup: any working member -> spinner', () => {
  render(<GroupActivityIndicator tabIds={['i', 'w']} />);
  expect(screen.getByLabelText('loading')).toBeInTheDocument();
});

test('group rollup: needs_input outranks working', () => {
  render(<GroupActivityIndicator tabIds={['w', 'n']} />);
  expect(screen.getByLabelText('status-needs_input')).toBeInTheDocument();
});
