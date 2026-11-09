import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, vi, test, expect } from 'vitest';
import App from './App';
import { useUI, loadView, type View } from './stores/ui';
import { useProjects } from './stores/projects';
import { useTabs } from './stores/tabs';
import { useNavigation, stopDesktopSync, __resetNavigationForTest } from './stores/navigation';

beforeEach(() => {
  vi.stubGlobal('WebSocket', class {
    onopen: any = null; onclose: any = null; onmessage: any = null;
    send() {} close() {}
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }));
  useUI.setState({ view: 'workspace' });
  useProjects.setState({ activeId: null });
  window.history.pushState({}, '', '/');
  localStorage.removeItem('dispatch:tabs'); // the open tabs an earlier test saved
  __resetNavigationForTest();
});
afterEach(() => { vi.unstubAllGlobals(); stopDesktopSync(); window.history.pushState({}, '', '/'); });

test('renders the app shell with the icon-rail navigation', { timeout: 30_000 }, async () => {
  render(<App />);
  // The brand text moved into the rail logo's dropdown; the rail's nav items are
  // the always-visible identity of the shell now.
  // The desktop shell is its own chunk since W2-E, so it shows one tick after the first render.
  expect(await screen.findByRole('button', { name: /^(Projects|Threads)$/ }, { timeout: 20_000 })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Board' })).not.toBeInTheDocument();
});

test('saved or requested Board views fall back to Threads', () => {
  localStorage.setItem('dispatch:view', 'board');
  expect(loadView()).toBe('workspace');
  render(<App />);
  // 'board' is no longer a View (W1-G); the cast stands for an untyped caller such as a plugin.
  act(() => { useUI.getState().setView('board' as View); });
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
  expect(useProjects.getState().activeId).toBe('s7');
  expect(useUI.getState().view).toBe('workspace');
  expect(window.location.pathname).toBe('/p/s7');
});

// W2-F (2026-11-09): the desktop has addresses. A thread link opens its thread, and stays in the address bar.
const thread = (id: string, sessionId: string) => ({ id, sessionId, type: 'shell', label: id, status: 'waiting', config: {}, archivedAt: null, createdAt: '2026-11-09T00:00:00.000Z' });
function serve(terminals: Record<string, unknown[]>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const m = String(url).match(/\/api\/sessions\/([^/]+)\/terminals/);
    const body = m ? (terminals[m[1]] ?? []) : String(url).endsWith('/api/sessions') ? [{ id: 'A', name: 'Alpha', workingDir: '/tmp/a', status: 'idle' }] : [];
    return { ok: true, status: 200, json: async () => body };
  }));
}

test('loading /p/A/t/T on desktop opens thread T', async () => {
  serve({ A: [thread('T', 'A'), thread('U', 'A')] });
  useTabs.setState({ byProject: {}, openTabIds: [], activeTabId: null, tabSession: {} });
  window.history.pushState({}, '', '/p/A/t/T');
  const before = window.history.length;
  render(<App />);
  await waitFor(() => expect(useTabs.getState().activeTabId).toBe('T'));
  expect(useProjects.getState().activeId).toBe('A');
  expect(useUI.getState().view).toBe('workspace');
  // The address stays (it was rewritten to "/" before W2-F), and the load adds no entry.
  expect(window.location.pathname).toBe('/p/A/t/T');
  expect(window.history.length).toBe(before);
  expect(useNavigation.getState().route).toEqual({ view: 'workspace', projectId: 'A', threadId: 'T' });
});

test('loading a thread address with an unknown id on desktop lands on its project', async () => {
  serve({ A: [thread('T', 'A')] });
  useTabs.setState({ byProject: {}, openTabIds: [], activeTabId: null, tabSession: {} });
  window.history.pushState({}, '', '/p/A/t/nope');
  render(<App />);
  await waitFor(() => expect(window.location.pathname).toBe('/p/A'));
  expect(useTabs.getState().activeTabId).toBeNull();
  expect(useProjects.getState().activeId).toBe('A');
});

test('on desktop, a thread picked in the app gets an address and Back returns to the earlier thread', async () => {
  serve({ A: [thread('T', 'A'), thread('U', 'A')] });
  useTabs.setState({ byProject: {}, openTabIds: [], activeTabId: null, tabSession: {} });
  window.history.pushState({}, '', '/p/A/t/T');
  render(<App />);
  await waitFor(() => expect(useTabs.getState().activeTabId).toBe('T'));
  await waitFor(() => { act(() => { useTabs.getState().setActiveTab('U'); }); expect(window.location.pathname).toBe('/p/A/t/U'); });
  act(() => { window.history.back(); });
  await waitFor(() => expect(useTabs.getState().activeTabId).toBe('T'));
  expect(window.location.pathname).toBe('/p/A/t/T');
});

test('the pending fields no longer exist on the UI store', () => {
  const s = useUI.getState() as unknown as Record<string, unknown>;
  expect(Object.keys(s).filter((k) => k.startsWith('pending') || k.startsWith('clear'))).toEqual([]);
});
