import { render, screen } from '@testing-library/react';
import { test, expect, beforeEach } from 'vitest';
import { AuthBanner } from './AuthBanner';
import { useAuth } from '../../stores/auth';

beforeEach(() => useAuth.setState({ requests: [] }));

test('renders nothing when there is no pending request', () => {
  const { container } = render(<AuthBanner />);
  expect(container).toBeEmptyDOMElement();
});

test('shows the auth url, open action, and callback-paste for a pending request', () => {
  useAuth.setState({ requests: [{ id: 'a1', url: 'https://example.com/oauth', status: 'pending' } as any] });
  render(<AuthBanner />);
  expect(screen.getByText('Authentication required')).toBeInTheDocument();
  expect(screen.getByText('https://example.com/oauth')).toBeInTheDocument();
  expect(screen.getByText('Open ↗')).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/localhost/)).toBeInTheDocument();
});
