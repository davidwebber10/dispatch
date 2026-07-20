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

test('renders the app shell with the Dispatch brand', () => {
  render(<App />);
  // "Dispatch" appears twice in the top bar: the product brand and the mode toggle.
  expect(screen.getAllByText('Dispatch').length).toBeGreaterThan(0);
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
