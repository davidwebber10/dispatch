import { render, screen } from '@testing-library/react';
import { test, expect, beforeEach } from 'vitest';
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
