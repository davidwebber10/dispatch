import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { test, expect, beforeEach, afterEach, describe, vi } from 'vitest';

const dismissAllAuth = vi.fn().mockResolvedValue({ completed: 3 });
const forwardAuthCallback = vi.fn();
vi.mock('../../api/client', () => ({
  api: {
    dismissAllAuth: () => dismissAllAuth(),
    completeAuth: vi.fn(),
    markAuthOpened: vi.fn(),
    forwardAuthCallback: (...a: unknown[]) => forwardAuthCallback(...a),
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

test('a shim-relayed URL with no sign-in signal reads as a plain link, without the callback-paste', () => {
  useAuth.setState({ requests: [{ id: 'a1', url: 'https://claude.ai/code/artifact/abc?via=auto_preview', source: 'system-opener', status: 'pending' } as any] });
  render(<AuthBanner />);
  expect(screen.getByText('Link to open')).toBeInTheDocument();
  expect(screen.queryByText(/Authentication required/)).not.toBeInTheDocument();
  // No OAuth callback exists for a plain link, so the paste field must not render.
  expect(screen.queryByPlaceholderText(/localhost/)).not.toBeInTheDocument();
  expect(screen.getByText(/Open in browser/)).toHaveAttribute('href', 'https://claude.ai/code/artifact/abc?via=auto_preview');
});

test('a terminal-output request is always a sign-in, whatever the URL looks like', () => {
  useAuth.setState({ requests: [{ id: 'a1', url: 'https://example.com/whatever', source: 'terminal-output', status: 'pending' } as any] });
  render(<AuthBanner />);
  expect(screen.getByText('Authentication required')).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/localhost/)).toBeInTheDocument();
});

test('a plain link still shows the agent label', () => {
  useAuth.setState({ requests: [{ id: 'a1', url: 'https://claude.ai/code/artifact/abc', source: 'system-opener', status: 'pending', terminalId: 't1' } as any] });
  useTabs.setState({ byProject: { proj1: [{ id: 't1', label: 'Gold intake form' } as any] } });
  render(<AuthBanner />);
  expect(screen.getByText('Link to open — Gold intake form')).toBeInTheDocument();
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

test('pasting a callback URL forwards it at once, with no Forward tap', async () => {
  forwardAuthCallback.mockReset().mockResolvedValue({});
  useAuth.setState({ requests: [{ id: 'a1', url: 'https://example.com/oauth', status: 'pending' } as any] });
  render(<AuthBanner />);
  const input = screen.getByPlaceholderText(/localhost/);
  fireEvent.paste(input, { clipboardData: { getData: () => ' localhost:39461/oauth/callback?code=x ' } });
  await waitFor(() => expect(forwardAuthCallback).toHaveBeenCalledWith('a1', 'http://localhost:39461/oauth/callback?code=x'));
});

test('a failed forward shows why and keeps the pasted URL for a retry', async () => {
  forwardAuthCallback.mockReset().mockRejectedValue(new Error('POST /api/auth-requests/a1/callback failed: 400 — That sign-in is no longer waiting'));
  useAuth.setState({ requests: [{ id: 'a1', url: 'https://example.com/oauth', status: 'pending' } as any] });
  render(<AuthBanner />);
  const input = screen.getByPlaceholderText(/localhost/) as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'localhost:1/cb?code=x' } });
  fireEvent.click(screen.getByText('Forward'));
  expect(await screen.findByText(/That sign-in is no longer waiting/)).toBeInTheDocument();
  expect(input.value).toBe('localhost:1/cb?code=x');
});

// ---- Phone layout (iPhone 17e PWA, 390pt) -------------------------------------------------
// The banner used to sit at top:48 and ignore the notch, so it covered the mobile header
// (calc(50px + env(safe-area-inset-top))) and its nav, with Dismiss unreachable.
const awsReq = { id: 'a1', url: 'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH', source: 'terminal-output', status: 'pending', terminalId: 't1' } as any;
const bannerEl = () => screen.getByTestId('auth-banner');
let prevWidth = 0;
const setWidth = (w: number) => { Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w }); };

describe('on a phone', () => {
  beforeEach(() => { prevWidth = window.innerWidth; setWidth(390); dismissAllAuth.mockReset().mockResolvedValue({ completed: 1 }); });
  afterEach(() => setWidth(prevWidth));

  test('sits below the mobile header, never over it', () => {
    useAuth.setState({ requests: [awsReq] });
    render(<AuthBanner />);
    const top = bannerEl().style.top;
    // jsdom folds calc(50px + … + 6px) to 56px: header height plus a 6px gap, under the notch.
    expect(top).toContain('env(safe-area-inset-top)');
    expect(top).toMatch(/5[0-9]px|6[0-9]px/);
    expect(top).not.toBe('48px');
    // Full width minus a gutter, not a centred 560pt box.
    expect(bannerEl().style.left).toBe('8px');
    expect(bannerEl().style.right).toBe('8px');
  });

  test('keeps room for the tab bar: the card is height-capped and its body scrolls', () => {
    useAuth.setState({ requests: [awsReq] });
    render(<AuthBanner />);
    expect(bannerEl().style.maxHeight).toContain('dvh');
    expect(screen.getByTestId('auth-banner-body').style.overflowY).toBe('auto');
    // Dismiss lives in the header row, outside the scrolling body.
    expect(screen.getByTestId('auth-banner-body')).not.toContainElement(screen.getByRole('button', { name: 'Dismiss' }));
  });

  test('Dismiss and Minimize are at least 44pt tall', () => {
    useAuth.setState({ requests: [awsReq] });
    render(<AuthBanner />);
    for (const name of ['Dismiss', 'Minimize']) {
      expect(parseInt(screen.getByRole('button', { name }).style.minHeight, 10)).toBeGreaterThanOrEqual(44);
    }
  });

  test('long URL wraps and the paste row cannot push past the card', () => {
    useAuth.setState({ requests: [{ ...awsReq, url: 'https://device.sso.us-east-1.amazonaws.com/' + 'x'.repeat(300) }] });
    render(<AuthBanner />);
    expect(bannerEl().style.boxSizing).toBe('border-box');
    expect(bannerEl().style.overflowX).toBe('hidden');
    const url = screen.getByTestId('auth-banner-url');
    expect(url.style.wordBreak).toBe('break-all');
    expect(url.style.overflowWrap).toBe('anywhere');
    const input = screen.getByPlaceholderText(/localhost/);
    expect(parseInt(input.style.minWidth, 10)).toBe(0);
    // 16px stops iOS zooming the page when the field is focused.
    expect(input.style.fontSize).toBe('16px');
    expect(screen.getByText('Forward').style.flexShrink).toBe('0');
  });
});

describe('minimize', () => {
  test('collapses to a pill that keeps the pending sign-in visible, and expands again', () => {
    useAuth.setState({ requests: [awsReq] });
    useTabs.setState({ byProject: { p: [{ id: 't1', label: 'Overseer' } as any] } });
    render(<AuthBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(screen.queryByPlaceholderText(/localhost/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Open in browser/)).not.toBeInTheDocument();
    const pill = screen.getByRole('button', { name: /Sign-in pending — Overseer/ });
    fireEvent.click(pill);
    expect(screen.getByPlaceholderText(/localhost/)).toBeInTheDocument();
  });

  test('the pill still offers Dismiss', async () => {
    dismissAllAuth.mockReset().mockResolvedValue({ completed: 1 });
    useAuth.setState({ requests: [awsReq] });
    render(<AuthBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(dismissAllAuth).toHaveBeenCalledTimes(1));
  });

  test('a different request re-opens the banner', () => {
    useAuth.setState({ requests: [awsReq] });
    render(<AuthBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    act(() => { useAuth.setState({ requests: [{ ...awsReq, id: 'a2' }] }); });
    expect(screen.getByPlaceholderText(/localhost/)).toBeInTheDocument();
  });
});

describe('Dismiss failure', () => {
  test('shows the server error instead of dropping it', async () => {
    dismissAllAuth.mockReset().mockRejectedValue(new Error('POST /api/auth-requests/complete-all failed: 500 — database is locked'));
    useAuth.setState({ requests: [awsReq] });
    render(<AuthBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/database is locked/);
    expect(screen.getByRole('button', { name: 'Dismiss' })).not.toBeDisabled(); // retryable
  });

  test('a failure from the minimized pill expands the banner so the error is seen', async () => {
    dismissAllAuth.mockReset().mockRejectedValue(new Error('network down'));
    useAuth.setState({ requests: [awsReq] });
    render(<AuthBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/network down/);
    expect(screen.getByRole('button', { name: 'Minimize' })).toBeInTheDocument();
  });
});

test('desktop keeps the old centred overlay at top 48', () => {
  const prev = window.innerWidth; setWidth(1280);
  useAuth.setState({ requests: [awsReq] });
  render(<AuthBanner />);
  expect(bannerEl().style.top).toBe('48px');
  expect(bannerEl().style.left).toBe('50%');
  expect(bannerEl().style.width).toBe('560px');
  setWidth(prev);
});
