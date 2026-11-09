import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { buildSdk } from './sdk';
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
    const base = buildSdk();
    tabs = []; menu = [];
    const DOCS = [doc('a', 't1', 'Perf report'), doc('bb', 't2', 'Other report'), doc('ccc', 't1', 'Perf screenshot')];
    const d = {
      ...base, id: 'previews',
      storage: { ...base.storage, all: vi.fn(async () => DOCS.map((v) => ({ key: `preview:${v.id}`, value: v }))), set: vi.fn(async () => {}) },
      events: { on: () => () => {} },
      register: (_id: string, c: { inspectorTabs?: typeof tabs; threadMenu?: { label: string }[] }) => { tabs.push(...(c.inspectorTabs ?? [])); menu.push(...(c.threadMenu ?? [])); },
    };
    activate(d as never);
  });

  // 2026-11-09: on a phone the tab is a thread-menu row too, so two rows both said "Previews".
  it('the thread-menu item for the project has its own name, not the tab\'s', () => {
    expect(menu.map((m) => m.label)).toEqual(['Project previews']);
    expect(tabs.map((t) => t.label)).not.toContain('Project previews');
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
