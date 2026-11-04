import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { WebSocket } from 'ws';
import { sendOrDrop } from './backpressure.js';

type Fake = WebSocket & { send: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; bufferedAmount: number; readyState: number; emit: (e: string) => void };
const fake = (bufferedAmount: number, readyState = 1): Fake => {
  const handlers: Record<string, () => void> = {};
  return { readyState, bufferedAmount, send: vi.fn(), terminate: vi.fn(), once: (e: string, fn: () => void) => { handlers[e] = fn; }, emit: (e: string) => handlers[e]?.() } as unknown as Fake;
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

  it('terminates a client that stays over the limit past the grace time, and logs it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = fake(50_000);
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
    const ws = fake(33 * 1024 * 1024);
    sendOrDrop(ws, 'big', 'chat');
    sendOrDrop(ws, 'small', 'chat');
    ws.bufferedAmount = 0; // the socket drained
    vi.advanceTimersByTime(6000);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('clears the timer when the socket closes', () => {
    const ws = fake(50_000);
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
