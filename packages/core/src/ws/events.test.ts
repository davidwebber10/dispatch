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

describe('events liveness ping', () => {
  it('answers the text "ping" with a pong and ignores anything else', async () => {
    const { WebSocketServer, WebSocket } = await import('ws');
    const { answerEventsPing, EVENTS_PONG } = await import('./events.js');
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (ws) => answerEventsPing(ws));
    await new Promise((r) => wss.once('listening', r));
    const port = (wss.address() as { port: number }).port;
    const c = new WebSocket(`ws://127.0.0.1:${port}`);
    const got: string[] = [];
    c.on('message', (d) => got.push(d.toString()));
    await new Promise((r) => c.once('open', r));
    c.send('hello');
    c.send('ping');
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([EVENTS_PONG]);
    c.close(); wss.close();
  });
});
