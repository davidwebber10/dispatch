// W3-C, one status authority: the chat shows "Working" from the daemon's status snapshot (the
// `system/status` frame of the structured socket), not from the frames it happens to see.
// `busy = snapshot.turnOpen || sending`. The old fold of the frames stays for a daemon that sends no
// status frame. The five tests that the engineering program names are in useStructuredChat.test.ts.
import { renderHook, act } from '@testing-library/react';
import { test, expect, vi, beforeEach, afterEach, describe } from 'vitest';
import { useStructuredChat } from './useStructuredChat';
import { SENDING_FALLBACK_MS } from './useChatBusy';
import * as sock from '../../../api/structured-socket';
import { api } from '../../../api/client';
import { threadViewCache } from '../../../lib/threadViewCache';

interface Cbs { onEvent: (e: any) => void; onReset?: () => void; onClose?: () => void; onReplayEnd?: () => void }
let cbs: Cbs;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  threadViewCache.clear();
  vi.spyOn(sock, 'openStructuredSocket').mockImplementation((opts: any) => { cbs = opts; return { close: () => {} }; });
});
afterEach(() => { vi.useRealTimers(); });

const status = (over: Record<string, unknown> = {}) => ({
  type: 'system', subtype: 'status', status: 'idle', turnOpen: false, generation: 100, sequence: 1, at: '2026-11-09T10:00:00.000Z', activity: null, ...over,
});
const working = (sequence: number, over: Record<string, unknown> = {}) => status({ status: 'working', turnOpen: true, sequence, ...over });
const idle = (sequence: number, over: Record<string, unknown> = {}) => status({ status: 'idle', turnOpen: false, sequence, ...over });
const streamStart = { type: 'stream_event', event: { type: 'message_start' } };
const toolStart = { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash' } } };
const assistantTool = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 600' } }] } };
const result = { type: 'result', is_error: false, num_turns: 1 };
const feed = (...events: unknown[]) => act(() => { for (const e of events) cbs.onEvent(e); });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

describe('busy comes from the status snapshot', () => {
  test('the client never computes busy from frames once the daemon sends a status', () => {
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(idle(1));
    // Every frame that used to set busy.
    for (const frame of [streamStart, toolStart, assistantTool]) { feed(frame); expect(r.current.busy).toBe(false); }
    feed(working(2));
    // Every frame that used to clear it.
    const clears = [
      result,
      { type: 'result', subtype: 'backfill', is_error: false },
      { type: 'result', is_error: true, subtype: 'process_exit', result: 'Process exited (1)' },
      { type: 'permission', pending: { requestId: 'r1', toolName: 'Bash', input: {} } },
      { type: 'system', subtype: 'spawn_error', message: 'nope' },
    ];
    for (const frame of clears) { feed(frame); expect(r.current.busy).toBe(true); }
    feed(idle(3));
    expect(r.current.busy).toBe(false);
  });

  test('a compaction status frame of the CLI is not a status snapshot', () => {
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(working(2));
    feed({ type: 'system', subtype: 'status', status: 'compacting' });
    expect(r.current.compacting).toBe(true);
    expect(r.current.busy).toBe(true);
    feed({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
    expect(r.current.compacting).toBe(false);
    expect(r.current.compactResult).toEqual({ success: true, error: undefined });
    expect(r.current.busy).toBe(true);
    // And a status snapshot does not touch the compaction state.
    feed({ type: 'system', subtype: 'status', status: 'compacting' });
    feed(working(3));
    expect(r.current.compacting).toBe(true);
  });
});

describe('sending', () => {
  test('after the POST is accepted, the first newer status frame ends sending whatever it says', async () => {
    vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(idle(3));
    act(() => r.current.send('/model'));
    await flush();
    feed(idle(3)); // the same sequence again: not newer, so sending stays
    expect(r.current.busy).toBe(true);
    feed(idle(4));
    expect(r.current.busy).toBe(false);
  });

  test('an idle frame of the turn before, in front of the POST answer, does not end sending', async () => {
    let accept: () => void = () => {};
    vi.spyOn(api, 'sendStructuredMessage').mockReturnValue(new Promise<void>((res) => { accept = () => res(); }) as any);
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(working(3));
    act(() => r.current.send('next'));
    feed(idle(4)); // the turn that ran when Send was pressed ends
    expect(r.current.busy).toBe(true);
    await act(async () => { accept(); await Promise.resolve(); });
    expect(r.current.busy).toBe(true);
    feed(working(5));
    feed(idle(6));
    expect(r.current.busy).toBe(false);
  });

  test('a failed POST ends sending at once', async () => {
    vi.spyOn(api, 'sendStructuredMessage').mockRejectedValue(new Error('400'));
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(idle(3));
    act(() => r.current.send('hello'));
    expect(r.current.busy).toBe(true);
    await flush();
    expect(r.current.busy).toBe(false);
    expect(r.current.items.at(-1)).toMatchObject({ kind: 'result', isError: true });
  });

  test('with no status frame in 10 s, sending ends with the snapshot read by REST', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
    const read = vi.spyOn(api, 'getTerminalStatus').mockResolvedValue({ status: 'idle', turnOpen: false, generation: 100, sequence: 3, at: 'x', activity: null });
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(idle(3));
    act(() => r.current.send('hello'));
    await act(async () => { await vi.advanceTimersByTimeAsync(SENDING_FALLBACK_MS - 1); });
    expect(read).not.toHaveBeenCalled();
    expect(r.current.busy).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(read).toHaveBeenCalledWith('t1');
    expect(r.current.busy).toBe(false);
  });

  test('the REST snapshot can also say that the turn runs, and a failed read still ends sending', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
    const read = vi.spyOn(api, 'getTerminalStatus').mockResolvedValue({ status: 'working', turnOpen: true, generation: 100, sequence: 9, at: 'x', activity: null });
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(idle(3));
    act(() => r.current.send('hello'));
    await act(async () => { await vi.advanceTimersByTimeAsync(SENDING_FALLBACK_MS + 1); });
    expect(r.current.busy).toBe(true); // from the snapshot now
    feed(idle(10));
    expect(r.current.busy).toBe(false);

    read.mockRejectedValue(new Error('offline'));
    act(() => r.current.send('again'));
    await act(async () => { await vi.advanceTimersByTimeAsync(SENDING_FALLBACK_MS + 1); });
    expect(r.current.busy).toBe(false);
  });

  test('a status frame cancels the 10 s read', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
    const read = vi.spyOn(api, 'getTerminalStatus').mockResolvedValue({ status: 'idle', turnOpen: false, generation: 100, sequence: 3, at: 'x', activity: null });
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(idle(3));
    act(() => r.current.send('hello'));
    feed(working(4));
    await act(async () => { await vi.advanceTimersByTimeAsync(SENDING_FALLBACK_MS * 2); });
    expect(read).not.toHaveBeenCalled();
    expect(r.current.busy).toBe(true);
  });

  test('an answer to a question shows busy until the status frame', async () => {
    vi.spyOn(api, 'answerPermission').mockResolvedValue(undefined as any);
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(working(3), status({ status: 'needs_input', sequence: 4 }), { type: 'permission', pending: { requestId: 'r1', toolName: 'AskUserQuestion', input: {}, questions: [{ question: 'Deploy?', options: [] }] } });
    expect(r.current.busy).toBe(false);
    expect(r.current.pending?.requestId).toBe('r1');
    act(() => { r.current.answer({ 'Deploy?': 'Yes' }); });
    expect(r.current.busy).toBe(true);
    await flush();
    feed(working(5));
    feed(idle(6));
    expect(r.current.busy).toBe(false);
  });
});

// One test for each class of "Working forever" in the engineering review. The daemon side of each is
// packages/core/tests/regression/working-forever.test.ts.
describe('Working forever', () => {
  test('stale working after exit: the status frame ends the spinner with no result frame', () => {
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(working(2), streamStart, toolStart);
    expect(r.current.busy).toBe(true);
    feed(status({ status: 'error', turnOpen: false, sequence: 3 }));
    expect(r.current.busy).toBe(false);
  });

  test('reconnect mid-turn: the header of the new connection decides, both ways', () => {
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(working(2), streamStart, toolStart);
    act(() => cbs.onClose?.());
    expect(r.current.busy).toBe(false); // no connection: nothing is known
    act(() => cbs.onReset?.());
    feed(working(2), streamStart, toolStart); // the turn still runs
    expect(r.current.busy).toBe(true);

    act(() => cbs.onClose?.());
    act(() => cbs.onReset?.());
    feed(idle(3), streamStart, toolStart, assistantTool); // it ended while the socket was down; the tail has no result
    expect(r.current.busy).toBe(false);
  });

  test('a missed result: the turn closes on the status frame alone', () => {
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(idle(1), working(2), streamStart, toolStart, assistantTool);
    expect(r.current.busy).toBe(true);
    feed(idle(3));
    expect(r.current.busy).toBe(false);
    expect(r.current.items.some((i) => i.kind === 'result')).toBe(false);
  });

  test('an interrupted turn: a reset of the status ends the spinner while frames still arrive', () => {
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(working(2), streamStart, toolStart);
    feed(idle(3)); // Stop, or the owner's Reset status
    feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } } });
    expect(r.current.busy).toBe(false);
  });

  test('a restart: the header of the new daemon wins over the last frame of the old one', () => {
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(working(250), streamStart, toolStart);
    act(() => cbs.onClose?.());
    act(() => cbs.onReset?.());
    // The new daemon counts from 0 in a higher generation.
    feed(status({ status: 'error', turnOpen: false, generation: 101, sequence: 0 }), streamStart, toolStart);
    expect(r.current.busy).toBe(false);
  });

  test('a restart with a clock that went back: the header of a new connection is taken as it is', () => {
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(working(250));
    act(() => cbs.onClose?.());
    act(() => cbs.onReset?.());
    feed(status({ status: 'idle', turnOpen: false, generation: 50, sequence: 0 }));
    expect(r.current.busy).toBe(false);
    feed(working(1, { generation: 50 }));
    expect(r.current.busy).toBe(true);
  });

  test('a Codex app-server crash: the synthetic result and the status frame end the turn in either order', () => {
    const exit = { type: 'result', is_error: true, subtype: 'process_exit', result: 'Process exited (1): app-server crashed' };
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(working(2), streamStart);
    feed(exit, status({ status: 'error', turnOpen: false, sequence: 3 }));
    expect(r.current.busy).toBe(false);
    expect(r.current.items.at(-1)).toMatchObject({ kind: 'result', isError: true });

    act(() => cbs.onReset?.());
    feed(working(4), streamStart);
    feed(status({ status: 'error', turnOpen: false, sequence: 5 }), exit);
    expect(r.current.busy).toBe(false);
  });

  test('a thread switch starts from nothing: the snapshot of the thread before is not shown', () => {
    const { result: r, rerender } = renderHook(({ id }) => useStructuredChat(id), { initialProps: { id: 't1' } });
    feed(working(2));
    expect(r.current.busy).toBe(true);
    rerender({ id: 't2' });
    expect(r.current.busy).toBe(false);
    feed(idle(1)); // lower than the frame of t1: a different thread, so it is not "older"
    feed(working(2));
    expect(r.current.busy).toBe(true);
  });
});

describe('compatibility', () => {
  test('old daemon: the 10 s read fails (no such route) and the fold keeps the spinner', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
    vi.spyOn(api, 'getTerminalStatus').mockRejectedValue(new Error('404'));
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    act(() => r.current.send('hello'));
    feed(streamStart, toolStart);
    await act(async () => { await vi.advanceTimersByTimeAsync(SENDING_FALLBACK_MS + 1); });
    expect(r.current.busy).toBe(true); // the turn runs: the frames say so
    feed(result);
    expect(r.current.busy).toBe(false);
  });

  test('a reconnect to an older daemon (a rollback) goes back to the fold', () => {
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    feed(working(2), streamStart);
    act(() => cbs.onClose?.());
    act(() => cbs.onReset?.());
    // The first frame of this connection is not a status frame: this daemon sends none.
    feed({ type: 'user', message: { role: 'user', content: 'go' } }, streamStart, toolStart);
    expect(r.current.busy).toBe(true);
    feed(result);
    expect(r.current.busy).toBe(false); // the snapshot of the newer daemon is not kept
  });

  test('a send before the first connection is busy, and the header then takes over', async () => {
    vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
    const { result: r } = renderHook(() => useStructuredChat('t1'));
    act(() => r.current.send('hello'));
    expect(r.current.busy).toBe(true);
    await flush();
    feed(working(1));
    expect(r.current.busy).toBe(true);
    feed(idle(2));
    expect(r.current.busy).toBe(false);
  });
});
