import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { INITIAL_REPLAY_MOBILE, MAX_REPLAY, nextReplayStep, openTerminalSocket, type TerminalWS } from './terminal-socket';

class FakeTermWS implements TerminalWS {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];
  send(d: string) { this.sent.push(d); }
  close() { this.onclose?.(); }
}

test('forwards output, sends raw input, and frames resize as JSON', () => {
  const chunks: string[] = [];
  let ws!: FakeTermWS;
  const sock = openTerminalSocket({
    terminalId: 't1',
    onData: (c) => chunks.push(c),
    wsFactory: () => (ws = new FakeTermWS()),
  });

  ws.onmessage!({ data: 'hello world' });
  expect(chunks).toEqual(['hello world']);

  ws.onopen!(); // simulate the socket opening so queued sends flush

  sock.send('ls\r');
  expect(ws.sent).toContain('ls\r');

  sock.resize(120, 40);
  expect(ws.sent).toContain(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));

  sock.close();
});

// ---- auto-reconnect (mirrors the events socket so a backgrounded desktop PWA
// whose terminal socket the server reaped self-heals without a manual refresh) ----

describe('auto-reconnect', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('reconnects after an unexpected close (server drop)', () => {
    const sockets: FakeTermWS[] = [];
    const sock = openTerminalSocket({
      terminalId: 't1',
      onData: () => {},
      wsFactory: () => { const ws = new FakeTermWS(); sockets.push(ws); return ws; },
    });

    expect(sockets).toHaveLength(1);
    sockets[0].onopen!();
    // Server reaps the socket — onclose fires without the consumer calling close().
    sockets[0].onclose!();

    expect(sockets).toHaveLength(1); // not yet — waits for backoff
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2); // reconnected

    sock.close();
  });

  test('does NOT reconnect after an explicit close()', () => {
    const sockets: FakeTermWS[] = [];
    const sock = openTerminalSocket({
      terminalId: 't1',
      onData: () => {},
      wsFactory: () => { const ws = new FakeTermWS(); sockets.push(ws); return ws; },
    });
    sockets[0].onopen!();

    sock.close(); // user navigated away / tab closed

    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1); // stayed closed
  });

  test('fires onReset on reconnect (so the consumer clears before replay), but not on the first open', () => {
    const events: string[] = [];
    const sockets: FakeTermWS[] = [];
    const sock = openTerminalSocket({
      terminalId: 't1',
      onData: (c) => events.push(`data:${c}`),
      onReset: () => events.push('reset'),
      wsFactory: () => { const ws = new FakeTermWS(); sockets.push(ws); return ws; },
    });

    sockets[0].onopen!();
    sockets[0].onmessage!({ data: 'initial' });
    expect(events).toEqual(['data:initial']); // no reset on the first connect

    sockets[0].onclose!();
    vi.advanceTimersByTime(500);
    sockets[1].onopen!();              // reconnected socket opens
    sockets[1].onmessage!({ data: 'replayed-buffer' });

    // reset must precede the replayed buffer so it lands on a clean screen
    expect(events).toEqual(['data:initial', 'reset', 'data:replayed-buffer']);

    sock.close();
  });
});

// ---- progressive scrollback: replay-size steps ----

describe('nextReplayStep', () => {
  test('steps 256K -> 1M -> 4M, saturating at MAX', () => {
    expect(nextReplayStep(INITIAL_REPLAY_MOBILE)).toBe(1_000_000);
    expect(nextReplayStep(1_000_000)).toBe(MAX_REPLAY);
    expect(nextReplayStep(MAX_REPLAY)).toBe(MAX_REPLAY); // saturates, does not exceed
  });

  test('never returns less than its input', () => {
    expect(nextReplayStep(0)).toBeGreaterThanOrEqual(0);
    expect(nextReplayStep(500_000)).toBeGreaterThanOrEqual(500_000);
    expect(nextReplayStep(MAX_REPLAY)).toBeGreaterThanOrEqual(MAX_REPLAY);
    // even past MAX (shouldn't happen in practice) it must not shrink
    expect(nextReplayStep(10_000_000)).toBeGreaterThanOrEqual(10_000_000);
  });

  test('constants match the design doc', () => {
    expect(INITIAL_REPLAY_MOBILE).toBe(256_000);
    expect(MAX_REPLAY).toBe(4_000_000);
  });
});

describe('connect URL replay size', () => {
  test('carries the requested replayBytes verbatim in the query string', () => {
    let capturedUrl = '';
    const sock = openTerminalSocket({
      terminalId: 't1',
      replayBytes: 999_000,
      onData: () => {},
      wsFactory: (u) => { capturedUrl = u; return new FakeTermWS(); },
    });

    // The server reads this exact param name (ws/terminal.ts) — a rename here
    // would silently fall back to the full 4 MB replay.
    expect(capturedUrl).toMatch(/[?&]replayBytes=999000(&|$)/);

    sock.close();
  });

  test('defaults to MAX_REPLAY (4 MB) when no replayBytes is passed, unchanged for desktop', () => {
    let capturedUrl = '';
    const sock = openTerminalSocket({
      terminalId: 't1',
      onData: () => {},
      wsFactory: (u) => { capturedUrl = u; return new FakeTermWS(); },
    });

    expect(capturedUrl).toMatch(new RegExp(`[?&]replayBytes=${MAX_REPLAY}(&|$)`));

    sock.close();
  });
});
