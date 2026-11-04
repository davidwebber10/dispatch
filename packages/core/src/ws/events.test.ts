import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WebSocketServer } from 'ws';
import { createEventsBroadcaster } from './events.js';

afterEach(() => { delete process.env.DISPATCH_WS_MAX_BUFFERED_BYTES; delete process.env.DISPATCH_WS_BUFFER_GRACE_MS; vi.useRealTimers(); vi.restoreAllMocks(); });

describe('events broadcaster back-pressure', () => {
  it('sends to healthy clients and drops the one that stays stalled, not the healthy one', () => {
    vi.useFakeTimers();
    process.env.DISPATCH_WS_MAX_BUFFERED_BYTES = '1000';
    process.env.DISPATCH_WS_BUFFER_GRACE_MS = '100';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mk = (bufferedAmount: number) => ({ readyState: 1, bufferedAmount, send: vi.fn(), terminate: vi.fn(), once: vi.fn() });
    const good = mk(10); const slow = mk(50_000);
    const b = createEventsBroadcaster({ clients: new Set([slow, good]) } as unknown as WebSocketServer);
    b.broadcast({ type: 'x' });
    expect(good.send).toHaveBeenCalledWith('{"type":"x"}');
    expect(slow.send).toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(good.terminate).not.toHaveBeenCalled();
    expect(slow.terminate).toHaveBeenCalledTimes(1);
  });
});
