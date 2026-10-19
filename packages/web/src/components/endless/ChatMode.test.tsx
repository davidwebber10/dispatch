import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatMode, openInThreads } from './ChatMode';
import { useOverseer } from '../overseer/store';
import { useEndless } from '../../stores/endless';
import { api } from '../../api/client';
import { useDocViewer } from '../../stores/docViewer';
import { useTabs } from '../../stores/tabs';
import { useUI } from '../../stores/ui';

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
});

describe('ChatMode', () => {
  it('watches the pane, mounts the lightbox in .overseer-root, and closes it on unmount', () => {
    vi.spyOn(api, 'endlessProjects').mockResolvedValue({ projects: [], threads: [], truncated: false } as any);
    vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: [], hasMore: false, hasMoreAfter: false } as any);
    vi.spyOn(api, 'endlessState').mockResolvedValue({ turn: { status: 'idle', error: null } } as any);
    const origWatch = useEndless.getState().watch;
    const watch = vi.fn(origWatch);
    useEndless.setState({ watch } as any);
    const { container, unmount } = render(<ChatMode />);
    expect(watch).toHaveBeenCalled();
    expect(container.querySelector('.overseer-root')).not.toBeNull();
    useOverseer.setState({ workerLightboxId: 't9' });
    unmount();
    expect(useOverseer.getState().workerLightboxId).toBeNull();
    useEndless.setState({ watch: origWatch } as any);
  });

  it('mounts the doc viewer once and closes it on unmount', async () => {
    vi.spyOn(api, 'endlessProjects').mockResolvedValue({ projects: [], threads: [], truncated: false } as any);
    vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: [], hasMore: false, hasMoreAfter: false } as any);
    vi.spyOn(api, 'endlessState').mockResolvedValue({ turn: { status: 'idle', error: null } } as any);
    vi.spyOn(api, 'endlessDoc').mockResolvedValue({ project: 's1', path: 'docs/a.md', absPath: null, source: 'main', worktree: null, branch: null, vsMain: 'same', modifiedAt: '2026-10-19T11:00:00Z', status: null, note: null, markdown: '# A' });
    const { unmount } = render(<ChatMode />);
    useDocViewer.getState().show({ project: 's1', path: 'docs/a.md', branch: null });
    expect(await screen.findAllByRole('dialog', { name: 'a.md' })).toHaveLength(1);
    unmount();
    expect(useDocViewer.getState().open).toBeNull();
  });

  it('the Projects button shows the need-you count', () => {
    const projects = [{ id: 's1', name: 'rollup', folder: '/w', live: 0, needsYou: 2, openItems: 0, lastReport: null, messages: 0 }];
    vi.spyOn(api, 'endlessProjects').mockResolvedValue({ projects, threads: [], truncated: false } as any);
    vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: [], hasMore: false, hasMoreAfter: false } as any);
    vi.spyOn(api, 'endlessState').mockResolvedValue({ turn: { status: 'idle', error: null } } as any);
    useEndless.setState({ projects });
    render(<ChatMode />);
    expect(screen.getByRole('button', { name: /Projects/ })).toHaveTextContent('2');
  });
});

describe('openInThreads (the lightbox Open in Threads)', () => {
  const setup = () => {
    const requestOpenThread = vi.fn();
    const setView = vi.fn();
    useUI.setState({ requestOpenThread, setView } as any);
    useOverseer.setState({ workerLightboxId: 't9' });
    return { requestOpenThread, setView };
  };
  it('a loaded terminal opens with its own session', () => {
    const { requestOpenThread, setView } = setup();
    useTabs.setState({ byProject: { s1: [{ id: 't9', sessionId: 's1' }] } } as any);
    useEndless.setState({ threads: [] });
    openInThreads('t9');
    expect(requestOpenThread).toHaveBeenCalledWith({ sessionId: 's1', terminalId: 't9' });
    expect(setView).toHaveBeenCalledWith('workspace');
    expect(useOverseer.getState().workerLightboxId).toBeNull();
  });
  it('a terminal the tabs have not loaded opens with the project from the pane row', () => {
    const { requestOpenThread, setView } = setup();
    useTabs.setState({ byProject: {} } as any);
    useEndless.setState({ threads: [{ id: 't9', project: 's2' }] as any });
    openInThreads('t9');
    expect(requestOpenThread).toHaveBeenCalledWith({ sessionId: 's2', terminalId: 't9' });
    expect(setView).toHaveBeenCalledWith('workspace');
  });
  it('no known project: nothing opens, the lightbox still closes', () => {
    const { requestOpenThread, setView } = setup();
    useTabs.setState({ byProject: {} } as any);
    useEndless.setState({ threads: [] });
    openInThreads('t9');
    expect(requestOpenThread).not.toHaveBeenCalled();
    expect(setView).not.toHaveBeenCalled();
    expect(useOverseer.getState().workerLightboxId).toBeNull();
  });
});
