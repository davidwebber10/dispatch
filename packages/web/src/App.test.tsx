import { act, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, vi, test, expect } from 'vitest';
import App from './App';
import { useUI, loadView } from './stores/ui';
import { useProjects } from './stores/projects';

beforeEach(() => {
  vi.stubGlobal('WebSocket', class {
    onopen: any = null; onclose: any = null; onmessage: any = null;
    send() {} close() {}
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }));
  useUI.setState({ view: 'workspace' });
  useProjects.setState({ activeId: null });
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

// Pinned card spec 2026-10-08, Unit 6: the one events socket routes ledger:changed to the card store.
test('the events socket routes ledger:changed to the pinned card store', async () => {
  const sockets: { onmessage: ((ev: { data: string }) => void) | null }[] = [];
  vi.stubGlobal('WebSocket', class {
    onopen: any = null; onclose: any = null; onmessage: any = null;
    constructor() { sockets.push(this); }
    send() {} close() {}
  });
  const { useLedgerCard } = await import('./stores/ledgerCard');
  const applyEvent = vi.spyOn(useLedgerCard.getState(), 'applyEvent');
  render(<App />);
  act(() => { sockets[0].onmessage?.({ data: JSON.stringify({ type: 'ledger:changed', sessionId: 'p1' }) }); });
  expect(applyEvent).toHaveBeenCalledWith({ type: 'ledger:changed', sessionId: 'p1' });
});

test('the open-project intent opens that project in the Threads view (desktop)', () => {
  useUI.setState({ view: 'chat' });
  render(<App />);
  act(() => { useUI.getState().requestOpenProject('s7'); });
  expect(useUI.getState().pendingOpenProject).toBeNull();
  expect(useProjects.getState().activeId).toBe('s7');
  expect(useUI.getState().view).toBe('workspace');
});
