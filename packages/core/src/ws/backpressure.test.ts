import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { WebSocket } from 'ws';
import { sendOrDrop } from './backpressure.js';

type Fake = WebSocket & { send: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; listenerCount: (e: string) => number; bufferedAmount: number; readyState: number; emit: (e: string) => void };
const fake = (bufferedAmount: number, readyState = 1): Fake => {
  const handlers: Record<string, Set<() => void>> = {};
  return { readyState, bufferedAmount, send: vi.fn(), terminate: vi.fn(),
    once: (e: string, fn: () => void) => { (handlers[e] ??= new Set()).add(fn); },
    off: (e: string, fn: () => void) => { handlers[e]?.delete(fn); },
    listenerCount: (e: string) => handlers[e]?.size ?? 0,
    emit: (e: string) => { for (const fn of [...(handlers[e] ?? [])]) fn(); } } as unknown as Fake;
};

beforeEach(() => { vi.useFakeTimers(); process.env.DISPATCH_WS_MAX_BUFFERED_BYTES = '1000'; process.env.DISPATCH_WS_BUFFER_GRACE_MS = '5000'; });
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  delete process.env.DISPATCH_WS_MAX_BUFFERED_BYTES; delete process.env.DISPATCH_WS_BUFFER_GRACE_MS;
});

describe('sendOrDrop', () => {
  it('sends to a client that is keeping up and starts no timer', () => {
    const ws = fake(10);
    expect(sendOrDrop(ws, 'hi', 'terminal')).toBe(true);
    expect(ws.send).toHaveBeenCalledWith('hi');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates a client over the limit whose queue does not shrink, and logs it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = fake(3500);
    expect(sendOrDrop(ws, 'a', 'terminal')).toBe(true);
    sendOrDrop(ws, 'b', 'terminal');
    expect(ws.send).toHaveBeenCalledTimes(2); // still sending during the grace time
    expect(vi.getTimerCount()).toBe(1); // one timer per socket, not per send
    vi.advanceTimersByTime(4999);
    expect(ws.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/slow terminal client/);
  });

  it('keeps a client that drains during the grace time (one big send, then small ones)', () => {
    const ws = fake(3500);
    sendOrDrop(ws, 'big', 'chat');
    sendOrDrop(ws, 'small', 'chat');
    ws.bufferedAmount = 0; // the socket drained
    vi.advanceTimersByTime(6000);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('leaves no close listener behind after repeated bursts that drain', () => {
    const ws = fake(3500);
    for (let i = 0; i < 12; i++) {
      ws.bufferedAmount = 3500;
      sendOrDrop(ws, 'big', 'chat');
      ws.bufferedAmount = 0;
      vi.advanceTimersByTime(6000);
    }
    expect(ws.listenerCount('close')).toBe(0);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('keeps a slow client that is still reading: the queue shrinks at each check but stays over the limit', () => {
    const ws = fake(3000); // limit 1000, ceiling 4000
    sendOrDrop(ws, 'a', 'chat');
    for (const left of [2500, 2000, 1500, 1100, 1050]) {
      ws.bufferedAmount = left; // the client read some before this check
      vi.advanceTimersByTime(5000);
      expect(ws.terminate).not.toHaveBeenCalled();
    }
    ws.bufferedAmount = 900; // drained under the limit
    vi.advanceTimersByTime(5000);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(ws.listenerCount('close')).toBe(0);
  });

  it('drops a client that was reading and then stops (no shrink between two checks)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = fake(3000);
    sendOrDrop(ws, 'a', 'chat');
    ws.bufferedAmount = 2500;
    vi.advanceTimersByTime(5000);
    expect(ws.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000); // still 2500: no progress
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it('drops a client at once when its queue passes the hard ceiling (4 times the limit)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = fake(4001);
    sendOrDrop(ws, 'a', 'chat');
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timer when the socket closes', () => {
    const ws = fake(3500);
    sendOrDrop(ws, 'a', 'events');
    ws.emit('close');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does nothing for a socket that is not open', () => {
    const ws = fake(0, 3);
    expect(sendOrDrop(ws, 'hi', 'events')).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('0 turns the cap off', () => {
    process.env.DISPATCH_WS_MAX_BUFFERED_BYTES = '0';
    const ws = fake(10 ** 9);
    expect(sendOrDrop(ws, 'hi', 'events')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
