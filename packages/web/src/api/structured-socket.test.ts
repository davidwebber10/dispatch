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
  expect(openedUrl).toBe('ws://localhost:3000/api/terminals/t1/structured-ws?tail=200&window=60&batch=1&journal=1'); // W3-D added journal=1
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

// ---- W3-D: the message journal ----
test('the socket asks for the journal, and a reconnect sends the cursor as after=<seq>', () => {
  vi.useFakeTimers();
  const urls: string[] = [];
  const sockets: FakeWS[] = [];
  let cursor: number | undefined;
  const sock = openStructuredSocket({
    terminalId: 't1', onEvent: () => {}, resumeAfter: () => cursor,
    wsFactory: (u) => { urls.push(u); const ws = new FakeWS(); sockets.push(ws); return ws; },
  });
  sockets[0].open();
  expect(urls[0]).toBe('ws://localhost:3000/api/terminals/t1/structured-ws?tail=200&window=60&batch=1&journal=1');
  cursor = 41;
  sockets[0].close(); // the connection drops
  vi.advanceTimersByTime(600);
  expect(urls[1]).toBe('ws://localhost:3000/api/terminals/t1/structured-ws?tail=200&window=60&batch=1&journal=1&after=41');
  cursor = undefined; // a block streams: no cursor
  sockets[1].open();
  sockets[1].close();
  vi.advanceTimersByTime(600);
  expect(urls[2]).toBe('ws://localhost:3000/api/terminals/t1/structured-ws?tail=200&window=60&batch=1&journal=1');
  sock.close();
  vi.useRealTimers();
});

test('a journal frame goes to onJournal, not to onEvent; the events after it go on as before', () => {
  const got: unknown[] = [];
  let ws!: FakeWS;
  const frame = { type: 'journal', reset: true, after: null, items: [{ seq: 1, kind: 'user', at: 'x', payload: { type: 'user' } }], firstSeq: 1, lastSeq: 1, hasMore: false };
  const sock = openStructuredSocket({
    terminalId: 't1', onEvent: (e) => got.push(['event', e]), onJournal: (f) => got.push(['journal', f]), onReplayEnd: () => got.push('END'),
    wsFactory: () => (ws = new FakeWS()),
  });
  ws.open();
  ws.msg({ type: 'replay', done: true, events: [frame, { type: 'system', subtype: 'model', model: 'm' }] });
  expect(got).toEqual([['journal', frame], ['event', { type: 'system', subtype: 'model', model: 'm' }], 'END']);
  sock.close();
});

test('with no onJournal, the items of a journal frame are delivered as events with their seq', () => {
  const got: unknown[] = [];
  let ws!: FakeWS;
  const sock = openStructuredSocket({ terminalId: 't1', onEvent: (e) => got.push(e), wsFactory: () => (ws = new FakeWS()) });
  ws.open();
  ws.msg({ type: 'journal', reset: true, after: null, items: [{ seq: 4, kind: 'user', at: 'x', payload: { type: 'user', message: { content: 'hi' } } }], firstSeq: 4, lastSeq: 4, hasMore: false });
  expect(got).toEqual([{ type: 'user', message: { content: 'hi' }, seq: 4 }]);
  sock.close();
});

test('onEventSeen gets each event before onEvent, in a replay and live', () => {
  const got: string[] = [];
  let ws!: FakeWS;
  const sock = openStructuredSocket({
    terminalId: 't1', onEvent: (e: any) => got.push(`event ${e.n}`), onEventSeen: (e: any) => got.push(`seen ${e.n}`),
    wsFactory: () => (ws = new FakeWS()),
  });
  ws.open();
  ws.msg({ type: 'replay', done: true, events: [{ n: 1 }, { n: 2 }] });
  ws.msg({ n: 3 });
  expect(got).toEqual(['seen 1', 'event 1', 'seen 2', 'event 2', 'seen 3', 'event 3']);
  sock.close();
});

// ---- I3 (final review of v4.5.0): a closed socket reaches nobody ----
/** A browser socket: close() does not fire `onclose` at once. A dead link fires it much later. */
class LateCloseWS implements TerminalWS {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  closeCalls = 0;
  send() {}
  close() { this.closeCalls++; }
}

test('close() detaches the handlers: a late close or message of the closed socket reaches nobody', () => {
  vi.useFakeTimers();
  const made: LateCloseWS[] = [];
  const got: unknown[] = [];
  let closes = 0;
  const sock = openStructuredSocket({
    terminalId: 't1', onEvent: (e) => got.push(e), onClose: () => { closes++; },
    wsFactory: () => { const w = new LateCloseWS(); made.push(w); return w; },
  });
  const ws = made[0];
  const { onopen, onclose, onmessage } = ws; // what the browser still holds for a socket that was not detached
  ws.onopen!();
  sock.close();
  expect(ws.closeCalls).toBe(1);
  expect(ws.onopen).toBeNull();
  expect(ws.onclose).toBeNull();
  expect(ws.onmessage).toBeNull();
  // The handlers of before close() are inert too (the view of this socket is gone).
  onmessage!({ data: JSON.stringify({ type: 'late' }) });
  onclose!();
  onopen!();
  expect(got).toEqual([]);
  expect(closes).toBe(0);
  vi.advanceTimersByTime(60_000);
  expect(made).toHaveLength(1); // and no reconnect
  vi.useRealTimers();
});
