import { act, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, vi, test, expect } from 'vitest';
import App from './App';
import { useUI } from './stores/ui';

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
  expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument();
});

test('toggling view in the ui store swaps the shell between the normal workspace and the board', () => {
  render(<App />);

  // Workspace mode: no board columns mounted.
  expect(screen.queryByTestId('board-view')).not.toBeInTheDocument();

  act(() => { useUI.getState().setView('board'); });
  expect(screen.getByTestId('board-view')).toBeInTheDocument();
  // Board mode bypasses Workspace entirely — its sidebar drag handle is gone too.
  expect(screen.queryByTestId('board-columns')).toBeInTheDocument();

  act(() => { useUI.getState().setView('workspace'); });
  expect(screen.queryByTestId('board-view')).not.toBeInTheDocument();
});
