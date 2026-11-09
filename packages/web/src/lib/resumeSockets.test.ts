import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resumeSockets, RESUME_ALIVE_TIMEOUT_MS } from './resumeSockets';
import { createEventsSocket, type WebSocketLike } from '../api/events-socket';
import { openStructuredSocket } from '../api/structured-socket';
import { openTerminalSocket } from '../api/terminal-socket';
import { useReconnect } from '../stores/reconnect';

class FakeWS implements WebSocketLike {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  readyState = 0;
  sent: string[] = [];
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function rig() {
  const events: FakeWS[] = []; const chats: FakeWS[] = []; const terms: FakeWS[] = [];
  let chatResets = 0; let termResets = 0;
  const ev = createEventsSocket({ onEvent: () => {}, onStatus: () => {}, wsFactory: () => { const w = new FakeWS(); events.push(w); return w; } });
  const chat = openStructuredSocket({ terminalId: 't1', onEvent: () => {}, onReset: () => { chatResets++; }, wsFactory: () => { const w = new FakeWS(); chats.push(w); return w as any; } });
  const term = openTerminalSocket({ terminalId: 't2', onData: () => {}, onReset: () => { termResets++; }, wsFactory: () => { const w = new FakeWS(); terms.push(w); return w as any; } });
  events[0].open(); chats[0].open(); terms[0].open();
  return { ev, chat, term, events, chats, terms, resets: () => ({ chatResets, termResets }), stop: () => { ev.close(); chat.close(); term.close(); } };
}

test('the wait for the pong is 4 s', () => { expect(RESUME_ALIVE_TIMEOUT_MS).toBe(4000); });

test('a slow resume: the pong arrives after 3 s, and nothing is reconnected or remounted', async () => {
  const r = rig();
  const gen = useReconnect.getState().gen;
  const done = resumeSockets(r.ev);
  expect(r.events[0].sent).toEqual(['ping']);
  await vi.advanceTimersByTimeAsync(3000);
  r.events[0].onmessage!({ data: '{"type":"pong"}' });
  expect(await done).toBe('alive');
  expect(r.events).toHaveLength(1);
  expect(r.chats).toHaveLength(1);
  expect(r.terms).toHaveLength(1);
  expect(useReconnect.getState().gen).toBe(gen);
  r.stop();
});

test('a dead connection: every socket is replaced, and the views are NOT remounted (the generation is not bumped)', async () => {
  const r = rig();
  const gen = useReconnect.getState().gen;
  const done = resumeSockets(r.ev);
  await vi.advanceTimersByTimeAsync(4000); // no pong
  expect(await done).toBe('reconnected');
  expect(r.events).toHaveLength(2);
  expect(r.chats).toHaveLength(2);
  expect(r.terms).toHaveLength(2);
  expect(useReconnect.getState().gen).toBe(gen);
  // Each view hears of the new connection through its own socket (onReset), and keeps its content until the replay.
  r.chats[1].open(); r.terms[1].open();
  expect(r.resets()).toEqual({ chatResets: 1, termResets: 1 });
  r.stop();
});

test('a check that ends after the events socket was replaced does nothing', async () => {
  const r = rig();
  const done = resumeSockets(r.ev, () => false); // the caller says: this is no longer the app's socket
  await vi.advanceTimersByTimeAsync(4000);
  expect(await done).toBe('stale');
  expect(r.events).toHaveLength(1);
  expect(r.chats).toHaveLength(1);
  r.stop();
});
