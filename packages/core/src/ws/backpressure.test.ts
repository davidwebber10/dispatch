import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { sendOrDrop } from './backpressure.js';

const fake = (bufferedAmount: number, readyState = 1) =>
  ({ readyState, bufferedAmount, send: vi.fn(), terminate: vi.fn() }) as unknown as WebSocket & { send: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };

afterEach(() => { delete process.env.DISPATCH_WS_MAX_BUFFERED_BYTES; vi.restoreAllMocks(); });

describe('sendOrDrop', () => {
  it('sends to a client that is keeping up', () => {
    const ws = fake(1000);
    expect(sendOrDrop(ws, 'hi', 'terminal')).toBe(true);
    expect(ws.send).toHaveBeenCalledWith('hi');
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('terminates a client with too much unread data, logs it, and sends nothing', () => {
    process.env.DISPATCH_WS_MAX_BUFFERED_BYTES = '1000';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = fake(5000);
    expect(sendOrDrop(ws, 'hi', 'terminal')).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/slow terminal client.*DISPATCH_WS|slow terminal client/);
  });

  it('does nothing for a socket that is not open', () => {
    const ws = fake(0, 3);
    expect(sendOrDrop(ws, 'hi', 'events')).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('0 turns the cap off', () => {
    process.env.DISPATCH_WS_MAX_BUFFERED_BYTES = '0';
    const ws = fake(10 ** 9);
    expect(sendOrDrop(ws, 'hi', 'events')).toBe(true);
    expect(ws.terminate).not.toHaveBeenCalled();
  });
});
