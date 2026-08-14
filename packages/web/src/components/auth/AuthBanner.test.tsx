import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { test, expect, beforeEach, vi } from 'vitest';

const dismissAllAuth = vi.fn().mockResolvedValue({ completed: 3 });
vi.mock('../../api/client', () => ({
  api: {
    dismissAllAuth: () => dismissAllAuth(),
    completeAuth: vi.fn(),
    markAuthOpened: vi.fn(),
    forwardAuthCallback: vi.fn(),
  },
}));

import { AuthBanner } from './AuthBanner';
import { useAuth } from '../../stores/auth';
import { useTabs } from '../../stores/tabs';

beforeEach(() => {
  useAuth.setState({ requests: [] });
  useTabs.setState({ byProject: {} });
});

test('renders nothing when there is no pending request', () => {
  const { container } = render(<AuthBanner />);
  expect(container).toBeEmptyDOMElement();
});

test('shows the auth url, open action, and callback-paste for a pending request', () => {
  useAuth.setState({ requests: [{ id: 'a1', url: 'https://example.com/oauth', status: 'pending' } as any] });
  render(<AuthBanner />);
  expect(screen.getByText('Authentication required')).toBeInTheDocument();
  expect(screen.getByText('https://example.com/oauth')).toBeInTheDocument();
  // "Open" is a real anchor to the system browser (not window.open / in-app).
  const open = screen.getByText(/Open in browser/);
  expect(open.tagName).toBe('A');
  expect(open).toHaveAttribute('href', 'https://example.com/oauth');
  expect(open).toHaveAttribute('target', '_blank');
  expect(screen.getByPlaceholderText(/localhost/)).toBeInTheDocument();
});

test('shows the agent/mission label when the request carries a resolvable terminalId', () => {
  useAuth.setState({ requests: [{ id: 'a1', url: 'https://example.com/oauth', status: 'pending', terminalId: 't1' } as any] });
  useTabs.setState({ byProject: { proj1: [{ id: 't1', label: 'Fix login bug' } as any] } });
  render(<AuthBanner />);
  expect(screen.getByText('Authentication required — Fix login bug')).toBeInTheDocument();
});

test('falls back to generic copy when terminalId does not resolve to a known terminal', () => {
  useAuth.setState({ requests: [{ id: 'a1', url: 'https://example.com/oauth', status: 'pending', terminalId: 'unknown' } as any] });
  render(<AuthBanner />);
  expect(screen.getByText('Authentication required')).toBeInTheDocument();
});

test('one Dismiss clears the whole queue, not just the top request', async () => {
  useAuth.setState({ requests: [
    { id: 'a', url: 'https://id.example.com/oauth/authorize?x=1', source: 'browser-env', terminalId: null, cwd: null, status: 'pending', error: null, createdAt: '', updatedAt: '' },
    { id: 'b', url: 'https://id.example.com/oauth/authorize?x=2', source: 'browser-env', terminalId: null, cwd: null, status: 'pending', error: null, createdAt: '', updatedAt: '' },
    { id: 'c', url: 'https://id.example.com/oauth/authorize?x=3', source: 'browser-env', terminalId: null, cwd: null, status: 'pending', error: null, createdAt: '', updatedAt: '' },
  ] } as never);
  render(<AuthBanner />);

  // The count tells you a burst is queued rather than leaving you to discover it by tapping.
  expect(screen.getByText('1 of 3')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));
  await waitFor(() => expect(dismissAllAuth).toHaveBeenCalledTimes(1));
});

test('a single request still reads as a plain Dismiss', () => {
  useAuth.setState({ requests: [
    { id: 'a', url: 'https://id.example.com/oauth/authorize?x=1', source: 'browser-env', terminalId: null, cwd: null, status: 'pending', error: null, createdAt: '', updatedAt: '' },
  ] } as never);
  render(<AuthBanner />);
  expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  expect(screen.queryByText(/1 of/)).not.toBeInTheDocument();
});
