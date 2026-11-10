import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createPluginSdk } from './facade';
import { useProjects } from '../stores/projects';
// The bundled Previews plugin is plain JS.
import activate from '../../../plugins/previews/web.js';

const doc = (id: string, terminalId: string, title: string) =>
  ({ id, sessionId: 's1', sessionName: 'Alpha', terminalId, terminalLabel: terminalId === 't1' ? 'Perf' : 'Other', title, note: null, text: `text ${id}`, files: [], createdAt: `2026-11-09T10:0${id.length}:00Z`, seenAt: 'seen' });

describe('Previews: a right-column tab for the open thread (2026-11-09)', () => {
  let menu: { label: string }[] = [];
  let tabs: { id: string; label: string; icon?: string; Component: React.ComponentType<{ terminalId: string | null; sessionId: string | null }> }[];
  beforeEach(() => {
    useProjects.setState({ sessions: [{ id: 's1', name: 'Alpha' }] as never });
    const base = createPluginSdk('previews');
    tabs = []; menu = [];
    const DOCS = [doc('a', 't1', 'Perf report'), doc('bb', 't2', 'Other report'), doc('ccc', 't1', 'Perf screenshot')];
    const d = {
      ...base,
      docs: { ...base.docs, entries: vi.fn(async () => DOCS.map((v) => ({ key: `preview:${v.id}`, value: v }))), set: vi.fn(async () => {}) },
      events: { on: () => () => {} },
      register: (c: { inspectorTabs?: typeof tabs; threadMenu?: { label: string }[] }) => { tabs.push(...(c.inspectorTabs ?? [])); menu.push(...(c.threadMenu ?? [])); },
    };
    activate(d as never);
  });

  // 2026-11-09: a thread shows its own previews only (the tab, which is also the phone's thread-menu
  // row); the project's previews belong to the project view. Two "Previews" rows were in the phone menu.
  it('adds no thread-menu item: the thread tab is the only Previews row in a thread', () => {
    expect(menu).toEqual([]);
    expect(tabs.map((t) => t.label)).toEqual(['Previews']);
  });

  it('registers a Previews tab', () => {
    expect(tabs.map((t) => t.label)).toEqual(['Previews']);
  });

  it('shows only the previews of the open thread', async () => {
    const Tab = tabs[0].Component;
    render(<Tab terminalId="t1" sessionId="s1" />);
    expect(await screen.findByText('Perf report')).toBeInTheDocument();
    expect(screen.getByText('Perf screenshot')).toBeInTheDocument();
    expect(screen.queryByText('Other report')).toBeNull();
  });

  it('a thread with no previews says so', async () => {
    const Tab = tabs[0].Component;
    render(<Tab terminalId="t9" sessionId="s1" />);
    expect(await screen.findByText(/No previews from this thread yet/)).toBeInTheDocument();
  });
});

// I8 (final review of v4.5.0): the thread tab rendered every card. On the phone it opens in a sheet, and
// on WSL2 (no sips) every picture is full size. It gets the same page of 20 as the History and the Sheet.
describe('Previews thread tab: a page of 20 with Show older', () => {
  type Tab = React.ComponentType<{ terminalId: string | null; sessionId: string | null }>;
  let Tab: Tab;
  beforeEach(() => {
    useProjects.setState({ sessions: [{ id: 's1', name: 'Alpha' }] as never });
    const base = createPluginSdk('previews');
    const tabs: { Component: Tab }[] = [];
    // 45 previews of thread t1 (newest first is Preview 0) and 3 of thread t2.
    const mine = Array.from({ length: 45 }, (_, i) => ({
      id: `p${i}`, sessionId: 's1', sessionName: 'Alpha', terminalId: 't1', terminalLabel: 'Perf', title: `Preview ${i}`, note: null, text: `text ${i}`,
      files: [], createdAt: new Date(Date.UTC(2026, 10, 9, 12, 0, 0) - i * 60_000).toISOString(), seenAt: 'seen',
    }));
    const other = Array.from({ length: 3 }, (_, i) => ({ ...mine[0], id: `o${i}`, terminalId: 't2', terminalLabel: 'Other', title: `Other ${i}` }));
    const DOCS = [...mine, ...other];
    const d = {
      ...base,
      docs: { ...base.docs, entries: vi.fn(async () => DOCS.map((v) => ({ key: `preview:${v.id}`, value: v }))), set: vi.fn(async () => {}) },
      events: { on: () => () => {} },
      register: (c: { inspectorTabs?: { Component: Tab }[] }) => { tabs.push(...(c.inspectorTabs ?? [])); },
    };
    activate(d as never);
    Tab = tabs[0].Component;
  });

  it('shows the newest 20 first, and Show older adds 20 at a time', async () => {
    render(<Tab terminalId="t1" sessionId="s1" />);
    await screen.findByText('Preview 0');
    expect(screen.queryByText('Preview 19')).not.toBeNull();
    expect(screen.queryByText('Preview 20')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show older (25 more)' }));
    expect(screen.queryByText('Preview 39')).not.toBeNull();
    expect(screen.queryByText('Preview 40')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show older (5 more)' }));
    expect(screen.queryByText('Preview 44')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Show older/ })).toBeNull();
  });

  it('another thread starts at its first page again, with no hook-order error', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(<Tab terminalId="t1" sessionId="s1" />);
    await screen.findByText('Preview 0');
    fireEvent.click(screen.getByRole('button', { name: /Show older/ }));
    expect(screen.queryByText('Preview 39')).not.toBeNull();
    rerender(<Tab terminalId="t2" sessionId="s1" />);
    expect(screen.queryByText('Other 2')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Show older/ })).toBeNull(); // 3 previews: no more pages
    rerender(<Tab terminalId={null} sessionId="s1" />);
    expect(screen.getByText('Open a thread to see its previews.')).toBeInTheDocument();
    rerender(<Tab terminalId="t1" sessionId="s1" />);
    expect(screen.queryByText('Preview 19')).not.toBeNull();
    expect(screen.queryByText('Preview 20')).toBeNull();
    expect(errors.mock.calls.filter((c) => /hook/i.test(String(c[0])))).toEqual([]);
    errors.mockRestore();
  });
});
