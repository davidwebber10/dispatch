import { describe, it, expect } from 'vitest';
import { attentionList, nextAttention, openNextAttention, useAttention, useAttentionShortcut, __resetAttentionForTest, type AttentionItem } from './attention';
import { beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, fireEvent, waitFor } from '@testing-library/react';
import { useTabs } from '../stores/tabs';
import { useProjects } from '../stores/projects';
import { useThreadStatus } from '../stores/threadStatus';
import { useNavigation, setMobileDriver, __resetNavigationForTest } from '../stores/navigation';
import { useHint } from '../stores/hint';
import { api } from '../api/client';
import type { Terminal } from '../api/types';

const term = (id: string, over: Partial<Terminal> = {}): Terminal => ({
  id, sessionId: 'p1', type: 'claude-code', label: id.toUpperCase(), pid: null, externalId: null, workingDir: null,
  status: 'waiting', createdAt: '2026-11-01T00:00:00.000Z', config: {}, archivedAt: null, sortOrder: 0, ...over,
} as Terminal);
const at = (min: number) => new Date(Date.UTC(2026, 10, 9, 10, min)).toISOString();

describe('attentionList', () => {
  it('orders needs input before error before stalled', () => {
    const byProject = {
      p1: [term('stalled', { status: 'working', lastActivityAt: at(0) }), term('err', { status: 'error', lastActivityAt: at(1) })],
      p2: [term('ask', { sessionId: 'p2', status: 'needs_input', lastActivityAt: at(2) }), term('idle', { sessionId: 'p2' }), term('busy', { sessionId: 'p2', status: 'working' })],
    };
    const list = attentionList({ byProject, status: {}, stalls: { stalled: Date.parse(at(0)) } });
    expect(list.map((i) => [i.terminalId, i.reason, i.projectId])).toEqual([['ask', 'needs_input', 'p2'], ['err', 'error', 'p1'], ['stalled', 'stalled', 'p1']]);
    expect(list[0]).toEqual({ terminalId: 'ask', projectId: 'p2', label: 'ASK', reason: 'needs_input', since: Date.parse(at(2)) });
    expect(list[2].since).toBe(Date.parse(at(0)));
  });

  it('oldest first in a group', () => {
    const byProject = { p1: [
      term('n-new', { status: 'needs_input', lastActivityAt: at(30) }),
      term('n-old', { status: 'needs_input', lastActivityAt: at(5) }),
      term('n-mid', { status: 'needs_input', lastActivityAt: at(10) }),
      term('e-new', { status: 'error', lastActivityAt: at(20) }),
      term('e-old', { status: 'error', lastActivityAt: at(1) }),
    ] };
    expect(attentionList({ byProject, status: {}, stalls: {} }).map((i) => i.terminalId)).toEqual(['n-old', 'n-mid', 'n-new', 'e-old', 'e-new']);
  });

  it('an archived thread is not listed', () => {
    const byProject = { p1: [term('gone', { status: 'needs_input', archivedAt: at(0) }), term('here', { status: 'needs_input' })] };
    expect(attentionList({ byProject, status: {}, stalls: { gone: 1 } }).map((i) => i.terminalId)).toEqual(['here']);
  });

  it('a file tab, a browser tab and the coordinator are not listed', () => {
    const byProject = { p1: [
      term('f', { type: 'file', status: 'needs_input' } as Partial<Terminal>),
      term('b', { type: 'browser', status: 'error' } as Partial<Terminal>),
      term('c', { status: 'needs_input', config: { role: 'coordinator' } }),
    ] };
    expect(attentionList({ byProject, status: {}, stalls: {} })).toEqual([]);
  });

  it('the live status wins over the stored row, in both directions', () => {
    const byProject = { p1: [term('a', { status: 'needs_input' }), term('b', { status: 'waiting' })] };
    const list = attentionList({ byProject, status: { a: { status: 'working', threadStatus: 'working' }, b: { status: 'needs_input' } }, stalls: {} });
    expect(list.map((i) => i.terminalId)).toEqual(['b']);
  });

  it('a stall flag counts only while the thread works, and a thread is listed once', () => {
    const byProject = { p1: [term('idle', { status: 'waiting' }), term('ask', { status: 'needs_input' }), term('busy', { status: 'working' })] };
    const list = attentionList({ byProject, status: {}, stalls: { idle: 5, ask: 5, busy: 7 } });
    expect(list.map((i) => [i.terminalId, i.reason])).toEqual([['ask', 'needs_input'], ['busy', 'stalled']]);
  });

  it('a thread with no activity time uses its creation time', () => {
    const byProject = { p1: [term('a', { status: 'error', createdAt: at(3) })] };
    expect(attentionList({ byProject, status: {}, stalls: {} })[0].since).toBe(Date.parse(at(3)));
  });
});

describe('nextAttention', () => {
  const items = ['a', 'b', 'c'].map((id) => ({ terminalId: id, projectId: 'p', label: id, reason: 'needs_input', since: 0 }) as AttentionItem);
  it('gives the first item when the open thread is not in the list', () => {
    expect(nextAttention(items, null)?.terminalId).toBe('a');
    expect(nextAttention(items, 'zzz')?.terminalId).toBe('a');
  });
  it('gives the item after the open thread, and wraps to the first', () => {
    expect(nextAttention(items, 'a')?.terminalId).toBe('b');
    expect(nextAttention(items, 'c')?.terminalId).toBe('a');
  });
  it('gives nothing for an empty list, and nothing when the open thread is the only item', () => {
    expect(nextAttention([], 'a')).toBeNull();
    expect(nextAttention(items.slice(0, 1), 'a')).toBeNull();
  });
});

describe('the live queue and the "next" shortcut', () => {
  let loadTabs: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    window.history.pushState({}, '', '/');
    __resetNavigationForTest();
    __resetAttentionForTest();
    setMobileDriver(null);
    vi.spyOn(api, 'listStalls').mockResolvedValue([]);
    useProjects.setState({ sessions: [{ id: 'p1', name: 'One', status: 'needs_input' }, { id: 'p2', name: 'Two', status: 'waiting' }, { id: 'p3', name: 'Three', status: 'working' }] as never, activeId: null });
    useTabs.setState({ byProject: {
      p1: [term('ask-b', { status: 'needs_input', lastActivityAt: at(20) }), term('ask-a', { status: 'needs_input', lastActivityAt: at(10) }), term('fine')],
      p2: [term('err', { sessionId: 'p2', status: 'error', lastActivityAt: at(1) })],
      p3: [term('slow', { sessionId: 'p3', status: 'working', lastActivityAt: at(2) })],
    }, openTabIds: [], activeTabId: null, tabSession: {} });
    useThreadStatus.setState({ byTerminal: {}, stalls: { slow: Date.parse(at(2)) } });
    loadTabs = vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as never);
    useHint.setState({ msg: null });
  });
  afterEach(() => { vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });
  const path = () => window.location.pathname;

  it('next walks the queue in order and wraps: needs input (oldest first), the error, the stalled thread', () => {
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) { expect(openNextAttention()).toBe(true); seen.push(path()); }
    expect(seen).toEqual(['/p/p1/t/ask-a', '/p/p1/t/ask-b', '/p/p2/t/err', '/p/p3/t/slow', '/p/p1/t/ask-a']);
    expect(useTabs.getState().activeTabId).toBe('ask-a');
  });

  it('next from a thread that is not in the queue goes to the first item', () => {
    useNavigation.getState().navigate({ view: 'workspace', projectId: 'p1', threadId: 'fine' });
    openNextAttention();
    expect(path()).toBe('/p/p1/t/ask-a');
  });

  it('next from another view goes to the first item, the open tab included', () => {
    useNavigation.getState().navigate({ view: 'workspace', projectId: 'p1', threadId: 'ask-a' });
    useNavigation.getState().navigate({ view: 'settings' });
    openNextAttention();
    expect(path()).toBe('/p/p1/t/ask-a');
  });

  it('next follows a live status change', () => {
    openNextAttention();
    expect(path()).toBe('/p/p1/t/ask-a');
    act(() => { useThreadStatus.getState().applyEvent({ type: 'terminal:status', terminalId: 'ask-b', status: 'working' } as never); });
    openNextAttention();
    expect(path()).toBe('/p/p2/t/err'); // ask-b works again: it left the queue
  });

  it('says so when nothing waits, and when only the open thread waits', () => {
    useTabs.setState({ byProject: { p1: [term('only', { status: 'needs_input' })] } });
    useThreadStatus.setState({ stalls: {} });
    expect(openNextAttention()).toBe(true);
    expect(openNextAttention()).toBe(false);
    expect(useHint.getState().msg).toBe('No other thread needs you.');
    expect(path()).toBe('/p/p1/t/only');
    useTabs.setState({ byProject: { p1: [term('only')] } });
    expect(openNextAttention()).toBe(false);
    expect(useHint.getState().msg).toBe('No thread needs you.');
  });

  it('Alt+N goes to the next item; it matches the physical key (Option+N is a dead key on a Mac)', () => {
    renderHook(() => useAttentionShortcut());
    const ev = new KeyboardEvent('keydown', { key: 'Dead', code: 'KeyN', altKey: true, bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(ev); });
    expect(path()).toBe('/p/p1/t/ask-a');
    expect(ev.defaultPrevented).toBe(true);
    act(() => { fireEvent.keyDown(window, { key: 'n', code: 'KeyN', altKey: true }); });
    expect(path()).toBe('/p/p1/t/ask-b');
  });

  it('plain N, Ctrl+Alt+N, Cmd+Alt+N and Alt+Shift+N do nothing', () => {
    renderHook(() => useAttentionShortcut());
    for (const mods of [{}, { altKey: true, ctrlKey: true }, { altKey: true, metaKey: true }, { altKey: true, shiftKey: true }]) {
      const ev = new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', bubbles: true, cancelable: true, ...mods });
      act(() => { window.dispatchEvent(ev); });
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(path()).toBe('/');
  });

  it('Alt+N inside a terminal is left to the shell', () => {
    renderHook(() => useAttentionShortcut());
    const host = document.createElement('div'); host.className = 'xterm';
    const ta = document.createElement('textarea'); host.appendChild(ta); document.body.appendChild(host);
    ta.focus();
    act(() => { fireEvent.keyDown(ta, { key: 'n', code: 'KeyN', altKey: true }); });
    expect(path()).toBe('/');
    host.remove();
  });

  it('on the phone, next goes through the phone driver', () => {
    const driver = { navigate: vi.fn(), onPop: vi.fn() };
    setMobileDriver(driver);
    openNextAttention();
    expect(driver.navigate).toHaveBeenCalledWith({ view: 'workspace', projectId: 'p1', threadId: 'ask-a' }, undefined);
    setMobileDriver(null);
  });

  it('useAttention gives the live list and reads the threads of projects that can hold an item, once', async () => {
    const { result, rerender } = renderHook(() => useAttention());
    expect(result.current.map((i) => i.terminalId)).toEqual(['ask-a', 'ask-b', 'err', 'slow']);
    // p1 needs input, p3 works (a stall needs a working thread), p2 is at rest but its saved list names an error.
    await waitFor(() => expect(loadTabs.mock.calls.map((c) => c[0]).sort()).toEqual(['p1', 'p2', 'p3']));
    act(() => { useProjects.setState({ sessions: [...useProjects.getState().sessions] }); });
    rerender();
    expect(loadTabs).toHaveBeenCalledTimes(3);
    act(() => { useThreadStatus.getState().applyEvent({ type: 'terminal:stall', terminalId: 'slow', stalledSince: null } as never); });
    expect(result.current.map((i) => i.terminalId)).toEqual(['ask-a', 'ask-b', 'err']);
  });

  it('a project at rest with no waiting thread is not read; it is read when its status changes', async () => {
    useProjects.setState({ sessions: [{ id: 'p9', name: 'Nine', status: 'waiting' }] as never });
    useTabs.setState({ byProject: {} });
    renderHook(() => useAttention());
    await act(async () => {});
    expect(loadTabs).not.toHaveBeenCalled();
    act(() => { useProjects.getState().applyEvent({ type: 'session:status', sessionId: 'p9', status: 'needs_input' } as never); });
    await waitFor(() => expect(loadTabs).toHaveBeenCalledWith('p9'));
  });
});
