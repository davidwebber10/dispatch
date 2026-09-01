import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { INITIAL_REPLAY_MOBILE, MAX_REPLAY, nextReplayStep, openTerminalSocket, type ReplayMeta, type TerminalWS } from './terminal-socket';

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

// ---- the replay size a RECONNECT asks for ----
//
// The size used to be captured once at construction, so a mobile socket that had
// been stepped up to 4 MB re-requested the original 256 KB the moment the network
// blipped: the terminal silently collapsed to the last 256 KB of history, and the
// reader's paged-back scrollback was gone with no way to notice why.

describe('setReplayBytes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('a reconnect requests the CURRENT replay size, not the one captured at construction', () => {
    const urls: string[] = [];
    const sockets: FakeTermWS[] = [];
    const sock = openTerminalSocket({
      terminalId: 't1',
      replayBytes: INITIAL_REPLAY_MOBILE,
      onData: () => {},
      wsFactory: (u) => { urls.push(u); const ws = new FakeTermWS(); sockets.push(ws); return ws; },
    });

    expect(urls[0]).toMatch(new RegExp(`[?&]replayBytes=${INITIAL_REPLAY_MOBILE}(&|$)`));
    sockets[0].onopen!();

    // The consumer paged back to the full window and told the socket about it.
    sock.setReplayBytes(MAX_REPLAY);

    // Server reaps the socket; the auto-reconnect must carry the NEW size.
    sockets[0].onclose!();
    vi.advanceTimersByTime(500);

    expect(urls).toHaveLength(2);
    expect(urls[1]).toMatch(new RegExp(`[?&]replayBytes=${MAX_REPLAY}(&|$)`));
    expect(urls[1]).not.toMatch(new RegExp(`[?&]replayBytes=${INITIAL_REPLAY_MOBILE}(&|$)`));

    sock.close();
  });

  test('every later reconnect keeps the updated size', () => {
    const urls: string[] = [];
    const sockets: FakeTermWS[] = [];
    const sock = openTerminalSocket({
      terminalId: 't1',
      replayBytes: INITIAL_REPLAY_MOBILE,
      onData: () => {},
      wsFactory: (u) => { urls.push(u); const ws = new FakeTermWS(); sockets.push(ws); return ws; },
    });
    sockets[0].onopen!();
    sock.setReplayBytes(1_000_000);

    sockets[0].onclose!();
    vi.advanceTimersByTime(500);
    sockets[1].onopen!();
    sockets[1].onclose!();
    vi.advanceTimersByTime(5000); // second backoff step

    expect(urls).toHaveLength(3);
    expect(urls[2]).toMatch(/[?&]replayBytes=1000000(&|$)/);

    sock.close();
  });
});

// ---- the dispatch:replay-meta control frame ----

const metaFrame = (m: Partial<ReplayMeta> = {}) =>
  JSON.stringify({ type: 'dispatch:replay-meta', startOffset: 0, totalWritten: 0, complete: false, ...m });

describe('replay meta', () => {
  test('requests meta=1 only when onMeta is supplied', () => {
    let withMeta = '';
    const a = openTerminalSocket({
      terminalId: 't1', onData: () => {}, onMeta: () => {},
      wsFactory: (u) => { withMeta = u; return new FakeTermWS(); },
    });
    let withoutMeta = '';
    const b = openTerminalSocket({
      terminalId: 't1', onData: () => {},
      wsFactory: (u) => { withoutMeta = u; return new FakeTermWS(); },
    });

    expect(withMeta).toMatch(/[?&]meta=1(&|$)/);
    // Mandatory for old-client/new-daemon safety: no opt-in, no control frame.
    expect(withoutMeta).not.toMatch(/meta=/);

    a.close(); b.close();
  });

  test('consumes the first-frame control frame and never forwards it as terminal data', () => {
    const chunks: string[] = [];
    const metas: ReplayMeta[] = [];
    let ws!: FakeTermWS;
    const sock = openTerminalSocket({
      terminalId: 't1',
      onData: (c) => chunks.push(c),
      onMeta: (m) => metas.push(m),
      wsFactory: () => (ws = new FakeTermWS()),
    });

    ws.onopen!();
    ws.onmessage!({ data: metaFrame({ startOffset: 4096, totalWritten: 99_999, complete: false }) });

    expect(metas).toEqual([{ startOffset: 4096, totalWritten: 99_999, complete: false }]);
    expect(chunks).toEqual([]); // the JSON must never reach the terminal

    ws.onmessage!({ data: 'REPLAY_BYTES' });
    expect(chunks).toEqual(['REPLAY_BYTES']);

    sock.close();
  });

  test('only the FIRST frame of a connection is examined — later meta-shaped output stays data', () => {
    const chunks: string[] = [];
    const metas: ReplayMeta[] = [];
    let ws!: FakeTermWS;
    const sock = openTerminalSocket({
      terminalId: 't1',
      onData: (c) => chunks.push(c),
      onMeta: (m) => metas.push(m),
      wsFactory: () => (ws = new FakeTermWS()),
    });

    ws.onopen!();
    ws.onmessage!({ data: metaFrame({ startOffset: 1 }) });
    // e.g. the user cats a log line that happens to be this exact JSON. It is real
    // terminal output and must be printed, not swallowed.
    ws.onmessage!({ data: metaFrame({ startOffset: 2 }) });

    expect(metas).toHaveLength(1);
    expect(metas[0].startOffset).toBe(1);
    expect(chunks).toEqual([metaFrame({ startOffset: 2 })]);

    sock.close();
  });

  test('a first frame that is not the control frame is delivered as data, untouched', () => {
    const cases = ['ordinary output', '{"type":"something-else"}', '{not json at all', '{}', ''];
    for (const first of cases) {
      const chunks: string[] = [];
      const metas: ReplayMeta[] = [];
      let ws!: FakeTermWS;
      const sock = openTerminalSocket({
        terminalId: 't1',
        onData: (c) => chunks.push(c),
        onMeta: (m) => metas.push(m),
        wsFactory: () => (ws = new FakeTermWS()),
      });

      ws.onopen!();
      ws.onmessage!({ data: first });

      expect(metas).toEqual([]);
      expect(chunks).toEqual([first]);
      sock.close();
    }
  });

  test('without onMeta, a meta-shaped first frame is still ordinary data', () => {
    const chunks: string[] = [];
    let ws!: FakeTermWS;
    const sock = openTerminalSocket({
      terminalId: 't1',
      onData: (c) => chunks.push(c),
      wsFactory: () => (ws = new FakeTermWS()),
    });

    ws.onopen!();
    ws.onmessage!({ data: metaFrame({ startOffset: 7 }) });

    // No opt-in means no parsing at all: whatever the server sends is the stream.
    expect(chunks).toEqual([metaFrame({ startOffset: 7 })]);

    sock.close();
  });

  test('the control frame is parsed again after a reconnect', () => {
    vi.useFakeTimers();
    try {
      const chunks: string[] = [];
      const metas: ReplayMeta[] = [];
      const sockets: FakeTermWS[] = [];
      const sock = openTerminalSocket({
        terminalId: 't1',
        onData: (c) => chunks.push(c),
        onMeta: (m) => metas.push(m),
        wsFactory: () => { const ws = new FakeTermWS(); sockets.push(ws); return ws; },
      });

      sockets[0].onopen!();
      sockets[0].onmessage!({ data: metaFrame({ startOffset: 10 }) });
      sockets[0].onmessage!({ data: 'FIRST' });

      sockets[0].onclose!();
      vi.advanceTimersByTime(500);
      sockets[1].onopen!();
      sockets[1].onmessage!({ data: metaFrame({ startOffset: 20, complete: true }) });
      sockets[1].onmessage!({ data: 'SECOND' });

      expect(metas.map((m) => m.startOffset)).toEqual([10, 20]);
      expect(metas[1].complete).toBe(true);
      expect(chunks).toEqual(['FIRST', 'SECOND']); // no JSON leaked into the terminal

      sock.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- declared viewer size (the width-scramble fix): cols/rows ride the ws URL so the
// server can resize the pty BEFORE reading the replay ----

describe('declared size on the URL', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('the size getter is read per connect and lands as cols/rows params', () => {
    const urls: string[] = [];
    let size: { cols: number; rows: number } | null = { cols: 132, rows: 43 };
    const sockets: FakeTermWS[] = [];
    const sock = openTerminalSocket({
      terminalId: 't1',
      onData: () => {},
      size: () => size,
      wsFactory: (u) => { urls.push(u); const ws = new FakeTermWS(); sockets.push(ws); return ws; },
    });
    expect(urls[0]).toContain('cols=132');
    expect(urls[0]).toContain('rows=43');

    // The viewer was re-fitted between connects: the reconnect must declare the
    // CURRENT size, not the construction-time one.
    size = { cols: 80, rows: 24 };
    sockets[0].onopen!();
    sockets[0].onclose!();
    vi.advanceTimersByTime(500);
    expect(urls[1]).toContain('cols=80');
    expect(urls[1]).toContain('rows=24');
    sock.close();
  });

  test('a null size (not fitted yet) omits the params entirely', () => {
    const urls: string[] = [];
    const sock = openTerminalSocket({
      terminalId: 't1',
      onData: () => {},
      size: () => null,
      wsFactory: (u) => { urls.push(u); return new FakeTermWS(); },
    });
    expect(urls[0]).not.toContain('cols=');
    expect(urls[0]).not.toContain('rows=');
    sock.close();
  });

  test('no size getter at all keeps the URL byte-identical to the old client', () => {
    const urls: string[] = [];
    const sock = openTerminalSocket({
      terminalId: 't1',
      onData: () => {},
      wsFactory: (u) => { urls.push(u); return new FakeTermWS(); },
    });
    expect(urls[0]).not.toContain('cols=');
    sock.close();
  });
});
