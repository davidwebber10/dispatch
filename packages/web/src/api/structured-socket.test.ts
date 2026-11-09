// packages/web/src/api/structured-socket.test.ts
import { test, expect, vi } from 'vitest';
import { openStructuredSocket, reconnectStructuredSockets, type TerminalWS } from './structured-socket';

test('opens the ws with a bounded ?tail= param so replay stays fast on long threads', () => {
  let openedUrl = '';
  const fakeWs: TerminalWS = { onopen: null, onclose: null, onmessage: null, send: () => {}, close: () => {} };
  const sock = openStructuredSocket({
    terminalId: 't1',
    onEvent: () => {},
    wsFactory: (u) => { openedUrl = u; return fakeWs; },
  });
  expect(openedUrl).toBe('ws://localhost:3000/api/terminals/t1/structured-ws?tail=200&batch=1');
  sock.close();
});

// ---- W2-I ----
class FakeWS implements TerminalWS {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  readyState = 0;
  closed = false;
  send() {}
  close() { this.closed = true; this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  msg(v: unknown) { this.onmessage?.({ data: JSON.stringify(v) }); }
}

test('a replay frame is unpacked into its events, in order, then onReplayEnd fires', () => {
  const got: unknown[] = [];
  let ws!: FakeWS;
  const sock = openStructuredSocket({ terminalId: 't1', onEvent: (e) => got.push(e), onReplayEnd: () => got.push('END'), wsFactory: () => (ws = new FakeWS()) });
  ws.open();
  ws.msg({ type: 'replay', done: false, events: [{ type: 'a', n: 1 }, { type: 'a', n: 2 }] });
  ws.msg({ type: 'replay', done: true, events: [{ type: 'a', n: 3 }] });
  ws.msg({ type: 'a', n: 4 }); // a live event after the replay
  expect(got).toEqual([{ type: 'a', n: 1 }, { type: 'a', n: 2 }, { type: 'a', n: 3 }, 'END', { type: 'a', n: 4 }]);
  sock.close();
});

test('an older daemon (no batch support) sends single frames and they pass through unchanged', () => {
  const got: unknown[] = [];
  let ws!: FakeWS;
  const sock = openStructuredSocket({ terminalId: 't1', onEvent: (e) => got.push(e), wsFactory: () => (ws = new FakeWS()) });
  ws.open();
  ws.msg({ type: 'system', subtype: 'inactive' });
  ws.msg({ type: 'user', message: { content: 'hi' } });
  expect(got).toEqual([{ type: 'system', subtype: 'inactive' }, { type: 'user', message: { content: 'hi' } }]);
  sock.close();
});

test('one event of a replay frame that makes the consumer throw does not lose the others', () => {
  const got: number[] = [];
  let ws!: FakeWS;
  const sock = openStructuredSocket({ terminalId: 't1', onEvent: (e: any) => { if (e.n === 2) throw new Error('bad'); got.push(e.n); }, wsFactory: () => (ws = new FakeWS()) });
  ws.open();
  ws.msg({ type: 'replay', done: true, events: [{ n: 1 }, { n: 2 }, { n: 3 }] });
  expect(got).toEqual([1, 3]);
  sock.close();
});

test('a socket in CONNECTING for 8 s closes and tries again', () => {
  vi.useFakeTimers();
  try {
    const made: FakeWS[] = [];
    let closes = 0;
    const sock = openStructuredSocket({ terminalId: 't1', onEvent: () => {}, onClose: () => { closes++; }, wsFactory: () => { const w = new FakeWS(); made.push(w); return w; } });
    vi.advanceTimersByTime(7999);
    expect(made).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(made[0].closed).toBe(true);
    expect(made).toHaveLength(2); // the retry is immediate
    expect(closes).toBe(1);
    made[1].open();
    vi.advanceTimersByTime(60_000);
    expect(made).toHaveLength(2); // an open socket is left alone
    sock.close();
  } finally { vi.useRealTimers(); }
});

test('reconnectStructuredSockets replaces each live socket at once and fires onReset when the new one opens', () => {
  const made: FakeWS[] = [];
  let resets = 0;
  const sock = openStructuredSocket({ terminalId: 't1', onEvent: () => {}, onReset: () => { resets++; }, wsFactory: () => { const w = new FakeWS(); made.push(w); return w; } });
  made[0].open();
  expect(resets).toBe(0);
  reconnectStructuredSockets();
  expect(made).toHaveLength(2);
  expect(made[0].closed).toBe(true);
  made[1].open();
  expect(resets).toBe(1);
  sock.close();
  reconnectStructuredSockets(); // a closed socket is not brought back
  expect(made).toHaveLength(2);
});
