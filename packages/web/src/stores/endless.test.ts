import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useEndless } from './endless';
import { api } from '../api/client';
import type { EndlessMessage } from '../api/types';

const msg = (i: number, over: Partial<EndlessMessage> = {}): EndlessMessage => ({ i, kind: 'user', text: `m${i}`, size: 2, project: null, projectName: null, ref: null, media: [], createdAt: 0, ...over });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'endlessProjects').mockResolvedValue([]);
  useEndless.setState({ messages: [], hasMore: false, atTail: true, loadingOlder: false, loaded: true, unavailable: false, filter: null, focus: null, liveText: '', liveThinking: '', turn: { status: 'idle', error: null }, projects: [] });
});

describe('useEndless', () => {
  it('appends a broadcast message at the tail, once', () => {
    useEndless.getState().applyEvent({ type: 'endless:message', message: msg(0) });
    useEndless.getState().applyEvent({ type: 'endless:message', message: msg(0) });
    expect(useEndless.getState().messages.map((m) => m.i)).toEqual([0]);
  });

  it('ignores another project while filtered, and new messages while reading history', () => {
    useEndless.setState({ filter: 'p1' });
    useEndless.getState().applyEvent({ type: 'endless:message', message: msg(0, { project: 'p2' }) });
    useEndless.getState().applyEvent({ type: 'endless:message', message: msg(1, { project: 'p1' }) });
    expect(useEndless.getState().messages.map((m) => m.i)).toEqual([1]);
    useEndless.setState({ atTail: false });
    useEndless.getState().applyEvent({ type: 'endless:message', message: msg(2, { project: 'p1' }) });
    expect(useEndless.getState().messages.map((m) => m.i)).toEqual([1]);
  });

  it('streams live text and thinking; the logged reply and the turn end clear them', () => {
    const s = useEndless.getState();
    s.applyEvent({ type: 'endless:delta', kind: 'thinking', text: 'hm' });
    s.applyEvent({ type: 'endless:delta', kind: 'text', text: 'Hel' });
    s.applyEvent({ type: 'endless:delta', kind: 'text', text: 'lo' });
    expect(useEndless.getState()).toMatchObject({ liveThinking: 'hm', liveText: 'Hello' });
    s.applyEvent({ type: 'endless:message', message: msg(0, { kind: 'unii', text: 'Hello' }) });
    expect(useEndless.getState()).toMatchObject({ liveThinking: '', liveText: '' });
    s.applyEvent({ type: 'endless:delta', kind: 'text', text: 'x' });
    s.applyEvent({ type: 'endless:turn', status: 'failed', error: 'boom' });
    expect(useEndless.getState()).toMatchObject({ liveText: '', turn: { status: 'failed', error: 'boom' } });
  });

  it('loadOlder prepends the previous page', async () => {
    useEndless.setState({ messages: [msg(5), msg(6)], hasMore: true });
    const spy = vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: [msg(3), msg(4)], hasMore: false, hasMoreAfter: false });
    await useEndless.getState().loadOlder();
    expect(spy).toHaveBeenCalledWith({ before: 5, limit: 60, project: null });
    expect(useEndless.getState().messages.map((m) => m.i)).toEqual([3, 4, 5, 6]);
    expect(useEndless.getState().hasMore).toBe(false);
  });

  it('openAt opens a window around a message and leaves the tail', async () => {
    vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: [msg(9), msg(10), msg(11)], hasMore: true, hasMoreAfter: true });
    await useEndless.getState().openAt(10);
    expect(useEndless.getState()).toMatchObject({ focus: 10, atTail: false });
  });

  it('marks Chat unavailable on a 503 instead of throwing, and recovers on the next good load', async () => {
    const spy = vi.spyOn(api, 'endlessMessages').mockRejectedValue(new Error('GET /api/endless/messages failed: 503 — Chat is unavailable'));
    await expect(useEndless.getState().loadTail()).resolves.toBeUndefined();
    expect(useEndless.getState()).toMatchObject({ unavailable: true, loaded: false });
    spy.mockResolvedValue({ messages: [msg(0)], hasMore: false, hasMoreAfter: false });
    await useEndless.getState().loadTail();
    expect(useEndless.getState()).toMatchObject({ unavailable: false, loaded: true });
  });

  it('reconnect reloads while unavailable and clears it', async () => {
    const spy = vi.spyOn(api, 'endlessMessages').mockRejectedValue(new Error('GET x failed: 503 — Chat is unavailable'));
    vi.spyOn(api, 'endlessState').mockResolvedValue({ turn: { status: 'idle', error: null }, total: 0, compactor: { unbuilt: 0, merges: 0, running: 0 } });
    await useEndless.getState().loadTail();
    expect(useEndless.getState().unavailable).toBe(true);
    spy.mockResolvedValue({ messages: [msg(0)], hasMore: false, hasMoreAfter: false });
    useEndless.getState().resyncAfterReconnect();
    await vi.waitFor(() => expect(useEndless.getState()).toMatchObject({ unavailable: false, loaded: true }));
  });

  it('drops a loadOlder result that resolves after the filter changed', async () => {
    useEndless.setState({ messages: [msg(5, { project: 'a' })], hasMore: true });
    let release!: (v: any) => void;
    const spy = vi.spyOn(api, 'endlessMessages').mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const older = useEndless.getState().loadOlder();
    spy.mockResolvedValue({ messages: [msg(8, { project: 'b' })], hasMore: false, hasMoreAfter: false });
    await useEndless.getState().setFilter('b');
    release({ messages: [msg(3, { project: 'a' })], hasMore: true, hasMoreAfter: false });
    await older;
    expect(useEndless.getState().messages.map((m) => m.i)).toEqual([8]);
    expect(useEndless.getState().filter).toBe('b');
  });

  it('loadOlder does not duplicate an i already present', async () => {
    useEndless.setState({ messages: [msg(5), msg(6)], hasMore: true });
    vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: [msg(4), msg(5)], hasMore: false, hasMoreAfter: false });
    await useEndless.getState().loadOlder();
    expect(useEndless.getState().messages.map((m) => m.i)).toEqual([4, 5, 6]);
  });

  it('keeps a message broadcast while loadTail was pending', async () => {
    let release!: (v: any) => void;
    vi.spyOn(api, 'endlessMessages').mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const p = useEndless.getState().loadTail();
    useEndless.getState().applyEvent({ type: 'endless:message', message: msg(3) });
    release({ messages: [msg(1), msg(2)], hasMore: false, hasMoreAfter: false });
    await p;
    expect(useEndless.getState().messages.map((m) => m.i)).toEqual([1, 2, 3]);
  });

  it('an interrupted turn clears the live text', () => {
    useEndless.setState({ liveText: 'a', liveThinking: 'b' });
    useEndless.getState().applyEvent({ type: 'endless:turn', status: 'interrupted' });
    expect(useEndless.getState()).toMatchObject({ liveText: '', liveThinking: '', turn: { status: 'interrupted' } });
  });

  it('a loadTail during a pending loadOlder does not leave loadingOlder stuck', async () => {
    useEndless.setState({ messages: [msg(5)], hasMore: true });
    let release!: (v: any) => void;
    const spy = vi.spyOn(api, 'endlessMessages').mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const older = useEndless.getState().loadOlder();
    spy.mockResolvedValue({ messages: [msg(5), msg(6)], hasMore: true, hasMoreAfter: false });
    await useEndless.getState().loadTail();
    release({ messages: [msg(3)], hasMore: true, hasMoreAfter: false });
    await older;
    expect(useEndless.getState().loadingOlder).toBe(false);
    spy.mockClear();
    await useEndless.getState().loadOlder();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reconnect while unavailable reloads even after a search jump', async () => {
    useEndless.setState({ unavailable: true, loaded: false, atTail: false });
    const spy = vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: [msg(0)], hasMore: false, hasMoreAfter: false });
    vi.spyOn(api, 'endlessState').mockResolvedValue({ turn: { status: 'idle', error: null }, total: 0, compactor: { unbuilt: 0, merges: 0, running: 0 } });
    useEndless.getState().resyncAfterReconnect();
    await vi.waitFor(() => expect(useEndless.getState()).toMatchObject({ unavailable: false, atTail: true }));
    expect(spy).toHaveBeenCalled();
  });
});
