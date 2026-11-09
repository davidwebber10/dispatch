import { expect, test, vi } from 'vitest';
import { createEventsSocket, type WebSocketLike } from './events-socket';

class FakeWS implements WebSocketLike {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  closed = false;
  close() { this.closed = true; this.onclose?.(); }
  emitOpen() { this.onopen?.(); }
  emitMessage(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

test('parses events and reports status transitions', () => {
  const events: any[] = [];
  const statuses: string[] = [];
  let ws!: FakeWS;
  const sock = createEventsSocket({
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    wsFactory: () => (ws = new FakeWS()),
  });

  expect(statuses).toContain('connecting');
  ws.emitOpen();
  expect(statuses).toContain('open');
  ws.emitMessage({ type: 'session:status', sessionId: 's1', status: 'working' });
  expect(events[0]).toEqual({ type: 'session:status', sessionId: 's1', status: 'working' });

  sock.close();
  expect(ws.closed).toBe(true);
});

test('reconnect() reports closed before the new socket opens, so the app resyncs missed events', () => {
  const statuses: string[] = [];
  const sockets: FakeWS[] = [];
  const sock = createEventsSocket({
    onEvent: () => {},
    onStatus: (s) => statuses.push(s),
    wsFactory: () => { const w = new FakeWS(); sockets.push(w); return w; },
  });
  sockets[0].emitOpen();
  statuses.length = 0;

  // App resume: the old pipe may be dead, and its onclose is detached, so reconnect() itself
  // must say the connection was lost. App.tsx resyncs on a closed -> open transition.
  sock.reconnect();
  sockets[1].emitOpen();
  expect(statuses).toEqual(['closed', 'connecting', 'open']);
});

class PingWS extends FakeWS {
  readyState = 1;
  sent: string[] = [];
  answer = true;
  send(data: string) { this.sent.push(data); if (this.answer) queueMicrotask(() => this.onmessage?.({ data: '{"type":"pong"}' })); }
}

test('checkAlive: true when the daemon answers the ping, and the pong is not passed on as an event', async () => {
  const events: unknown[] = [];
  let ws!: PingWS;
  const sock = createEventsSocket({ onEvent: (e) => events.push(e), onStatus: () => {}, wsFactory: () => (ws = new PingWS()) });
  ws.emitOpen();
  await expect(sock.checkAlive(1000)).resolves.toBe(true);
  expect(ws.sent).toEqual(['ping']);
  expect(events).toEqual([]);
  sock.close();
});

test('checkAlive: false when no answer comes in time (a socket iOS killed), or the socket is not open', async () => {
  let ws!: PingWS;
  const sock = createEventsSocket({ onEvent: () => {}, onStatus: () => {}, wsFactory: () => (ws = new PingWS()) });
  ws.answer = false;
  await expect(sock.checkAlive(20)).resolves.toBe(false);
  ws.readyState = 3;
  await expect(sock.checkAlive(20)).resolves.toBe(false);
  sock.close();
});

// W2-I: a socket that never leaves CONNECTING (a cellular link that swallowed the handshake) is not waited on for ever.
test('a socket in CONNECTING for 8 s closes and tries again', () => {
  vi.useFakeTimers();
  try {
    const made: FakeWS[] = [];
    const statuses: string[] = [];
    const sock = createEventsSocket({ onEvent: () => {}, onStatus: (s) => statuses.push(s), wsFactory: () => { const w = new FakeWS(); made.push(w); return w; } });
    vi.advanceTimersByTime(7999);
    expect(made).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(made[0].closed).toBe(true);
    expect(made).toHaveLength(2);
    expect(statuses).toEqual(['connecting', 'closed', 'connecting']);
    made[1].emitOpen();
    vi.advanceTimersByTime(60_000);
    expect(made).toHaveLength(2); // an open socket is left alone
    expect(statuses).toEqual(['connecting', 'closed', 'connecting', 'open']);
    // The socket that timed out fires its close late: it must not start another connection.
    made[0].onclose?.();
    vi.advanceTimersByTime(10_000);
    expect(made).toHaveLength(2);
    sock.close();
  } finally { vi.useRealTimers(); }
});

test('a connection that opens in time is not closed by the timer, and a later drop still reconnects with backoff', () => {
  vi.useFakeTimers();
  try {
    const made: FakeWS[] = [];
    const sock = createEventsSocket({ onEvent: () => {}, onStatus: () => {}, wsFactory: () => { const w = new FakeWS(); made.push(w); return w; } });
    vi.advanceTimersByTime(3000);
    made[0].emitOpen();
    vi.advanceTimersByTime(20_000);
    expect(made).toHaveLength(1);
    made[0].close();
    vi.advanceTimersByTime(500);
    expect(made).toHaveLength(2);
    sock.close();
  } finally { vi.useRealTimers(); }
});
