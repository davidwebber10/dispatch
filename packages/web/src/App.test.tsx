import { act, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, vi, test, expect } from 'vitest';
import App from './App';
import { useUI, loadView } from './stores/ui';

beforeEach(() => {
  vi.stubGlobal('WebSocket', class {
    onopen: any = null; onclose: any = null; onmessage: any = null;
    send() {} close() {}
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }));
  useUI.setState({ view: 'workspace' });
});
afterEach(() => vi.unstubAllGlobals());

test('renders the app shell with the icon-rail navigation', () => {
  render(<App />);
  // The brand text moved into the rail logo's dropdown; the rail's nav items are
  // the always-visible identity of the shell now.
  expect(screen.getByRole('button', { name: 'Threads' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Board' })).not.toBeInTheDocument();
});

test('saved or requested Board views fall back to Threads', () => {
  localStorage.setItem('dispatch:view', 'board');
  expect(loadView()).toBe('workspace');
  render(<App />);
  act(() => { useUI.getState().setView('board'); });
  expect(useUI.getState().view).toBe('workspace');
  expect(screen.queryByTestId('board-view')).not.toBeInTheDocument();
});
