import { expect, test } from 'vitest';
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
