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
