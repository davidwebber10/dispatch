import { render, waitFor, act } from '@testing-library/react';
import { vi, test, expect, beforeEach, afterEach, type Mock } from 'vitest';

// A minimal fake xterm Terminal that models just enough async behaviour to make
// the rebuild ordering/anchor tests meaningful:
//  - write(data, cb) records the call SYNCHRONOUSLY (so ordering assertions are
//    reliable) but only applies it to buffer.active.length on a later microtask
//    and invokes cb then — mirroring real xterm's async parse. A component that
//    reads buffer.active.length synchronously right after calling write() (the
//    documented gotcha) would compute the OLD length, not the new one.
//  - reset() clears the buffer, scrollToLine() records the requested line.
//  - onScroll() registers a handler fireScroll() can invoke to simulate the
//    reader scrolling the viewport (set buffer.active.viewportY first).
const { instances } = vi.hoisted(() => ({ instances: [] as any[] }));
vi.mock('@xterm/xterm', () => {
  class FakeTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = { active: { length: 0, viewportY: 0, baseY: 0 } };
    written: string[] = [];
    dataHandler: ((d: string) => void) | null = null;
    private scrollHandlers: Array<() => void> = [];
    constructor() { instances.push(this); }
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    // Captures the component's term.onData((d) => sock.send(d)) registration so
    // tests can simulate a keystroke and see which socket it was routed to.
    onData(cb: (d: string) => void) { this.dataHandler = cb; return { dispose: () => {} }; }
    onScroll(cb: () => void) { this.scrollHandlers.push(cb); return { dispose: () => {} }; }
    onRender() { return { dispose() {} }; }
    scrollLines() {}
    scrollToBottom() {}
    scrollToLine(line: number) { this.buffer.active.viewportY = line; }
    reset() { this.buffer.active.length = 0; this.buffer.active.viewportY = 0; this.buffer.active.baseY = 0; }
    write(data: string, cb?: () => void) {
      this.written.push(data);
      queueMicrotask(() => {
        this.buffer.active.length += data.length;
        this.buffer.active.baseY = Math.max(0, this.buffer.active.length - this.rows);
        cb?.();
      });
    }
    fireScroll() { this.scrollHandlers.forEach((h) => h()); }
  }
  return { Terminal: FakeTerminal };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

const { isMobileMock } = vi.hoisted(() => ({ isMobileMock: vi.fn(() => false) }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: isMobileMock }));

import { TerminalTab } from './TerminalTab';
import { api } from '../../api/client';
import { INITIAL_REPLAY_MOBILE, MAX_REPLAY, nextReplayStep } from '../../api/terminal-socket';

type FakeMeta = { startOffset: number; totalWritten: number; complete: boolean };
type FakeOpts = { terminalId: string; replayBytes?: number; onData: (c: string) => void; onMeta?: (m: FakeMeta) => void; onReset?: () => void; onClose?: () => void };

function makeSocketFactory() {
  const created: { opts: FakeOpts; close: Mock; send: Mock; resize: Mock; setReplayBytes: Mock }[] = [];
  const factory = (opts: FakeOpts) => {
    const entry = { opts, close: vi.fn(), send: vi.fn(), resize: vi.fn(), setReplayBytes: vi.fn() };
    created.push(entry);
    return { send: entry.send, resize: entry.resize, close: entry.close, setReplayBytes: entry.setReplayBytes };
  };
  return { factory, created };
}

const meta = (startOffset: number, over: Partial<FakeMeta> = {}): FakeMeta =>
  ({ startOffset, totalWritten: 10_000_000, complete: false, ...over });

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  instances.length = 0;
  isMobileMock.mockReturnValue(false);
  vi.spyOn(api, 'getTerminal').mockResolvedValue({ id: 't1', sessionId: 's1', workingDir: '/p/x', pid: 4242, status: 'working' } as any);
  vi.spyOn(api, 'getGitInfo').mockResolvedValue({ branch: 'main' });
  vi.spyOn(api, 'getScrollbackSize').mockResolvedValue(0);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test('mounts the terminal and wires the socket for replayed output', async () => {
  let onData!: (c: string) => void;
  const fakeFactory = (opts: any) => { onData = opts.onData; return { send: vi.fn(), resize: vi.fn(), close: vi.fn() }; };

  render(<TerminalTab terminalId="t1" socketFactory={fakeFactory as any} />);
  await waitFor(() => expect(api.getTerminal).toHaveBeenCalledWith('t1'));
  // The socket's onData is wired through to the terminal without throwing.
  expect(() => onData('hello-from-pty')).not.toThrow();
});

// ---- initial replay size: mobile small, desktop unchanged ----

test('mobile mount requests the small initial replay (256_000)', async () => {
  isMobileMock.mockReturnValue(true);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  expect(created[0].opts.replayBytes).toBe(INITIAL_REPLAY_MOBILE);
});

test('desktop mount requests MAX_REPLAY (4_000_000) — byte-identical to today', async () => {
  isMobileMock.mockReturnValue(false);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  expect(created[0].opts.replayBytes).toBe(MAX_REPLAY);
});

// ---- scroll-to-top rebuild: triggers once, at the next step ----

test('scroll-to-top with more history triggers exactly one rebuild, at the next step', async () => {
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000); // more than the 256K requested
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('INITIAL_REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));

  const term = instances[0];
  await waitFor(() => {
    term.buffer.active.viewportY = 0;
    act(() => { term.fireScroll(); });
    expect(created).toHaveLength(2);
  });
  expect(created[1].opts.replayBytes).toBe(nextReplayStep(INITIAL_REPLAY_MOBILE));

  // A second scroll event while the rebuild is still in flight must NOT start another.
  term.buffer.active.viewportY = 0;
  act(() => { term.fireScroll(); });
  await tick();
  expect(created).toHaveLength(2);
});

// ---- live output arriving mid-rebuild: buffered, written after the replay, in order ----

test('live frames arriving mid-rebuild are written after the replay, in arrival order', async () => {
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('INITIAL_REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));

  const term = instances[0];
  await waitFor(() => {
    term.buffer.active.viewportY = 0;
    act(() => { term.fireScroll(); });
    expect(created).toHaveLength(2);
  });

  // The new socket's FIRST message is the replay frame. Before its write callback
  // fires, simulate live output arriving on BOTH the old (still open) socket and
  // the new one — this must all be buffered, not written immediately.
  //
  // NOTE the distinct labels are a TEST FICTION. In production both sockets are subscribed to
  // the SAME pty (ws/terminal.ts adds one 'data' listener per connection), so these two frames
  // are byte-identical: 'LIVE_OLD' and 'LIVE_NEW' are the same chunk arriving twice. Writing
  // both — which this test used to assert — duplicated every mid-rebuild chunk, and a doubled
  // cursor/scroll-region escape moves the cursor twice as far, overwriting lines that should
  // have survived. Only the NEW socket's copy is written: it is the one contiguous with the
  // fresh replay snapshot this rebuild just reset to.
  act(() => {
    created[1].opts.onData('REPLAY2');
    created[0].opts.onData('LIVE_OLD');
    created[1].opts.onData('LIVE_NEW');
  });

  // Rebuild completes (old socket closed) once everything has drained.
  await waitFor(() => expect(created[0].close).toHaveBeenCalled());

  expect(term.written).toEqual(['INITIAL_REPLAY', 'REPLAY2', 'LIVE_NEW']);
});

test('a rebuild that stalls out replays the frames withheld from the OLD socket (no lost output)', async () => {
  // The data-loss bug: while a rebuild is in flight the primary socket's frames are withheld
  // from the terminal. Abort used to drop them, and since the old view is never reset nothing
  // ever replayed them — up to 10s of PTY output silently gone.
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('INITIAL_REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));
  await tick();

  const term = instances[0];
  term.buffer.active.viewportY = 0;

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    act(() => { term.fireScroll(); });   // starts the rebuild
    expect(created).toHaveLength(2);

    // Live output lands on the PRIMARY socket while the rebuild is pending — buffered, not shown.
    act(() => { created[0].opts.onData('WITHHELD_1'); created[0].opts.onData('WITHHELD_2'); });
    expect(term.written).toEqual(['INITIAL_REPLAY']);

    // The new socket never delivers its replay, so the stall guard aborts.
    act(() => { vi.advanceTimersByTime(10_000); });

    // Both withheld frames are recovered, in arrival order, onto the still-intact old view.
    expect(term.written).toEqual(['INITIAL_REPLAY', 'WITHHELD_1', 'WITHHELD_2']);
    expect(created[0].close).not.toHaveBeenCalled();  // the old socket stayed primary
  } finally {
    vi.useRealTimers();
  }
});

// ---- anchor restore uses the POST-write length (computed in the write callback) ----

test('anchor restoration is computed from the post-write buffer length, not read synchronously after write()', async () => {
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('I'.repeat(10)); }); // buffer.active.length settles at 10
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));

  const term = instances[0];
  const scrollSpy = vi.spyOn(term, 'scrollToLine');

  await waitFor(() => {
    term.buffer.active.viewportY = 0; // rebuild only triggers exactly at the top
    act(() => { term.fireScroll(); });
    expect(created).toHaveLength(2);
  });

  act(() => { created[1].opts.onData('B'.repeat(200)); }); // the bigger replay
  await waitFor(() => expect(created[0].close).toHaveBeenCalled());

  // oldLength=10, newLength=200, oldViewportY=0 -> scrollToLine(190). If the
  // implementation read buffer.active.length synchronously right after write()
  // instead of in its callback, newLength would still read as 10 (our fake only
  // applies the write on a later microtask) and this would be called with 0.
  expect(scrollSpy).toHaveBeenCalledWith(190);
});

// ---- ceiling: no further rebuild once at MAX_REPLAY, or once delivered === totalBytes ----

test('at MAX_REPLAY, no further rebuild is attempted even if more history is (implausibly) reported', async () => {
  isMobileMock.mockReturnValue(false); // desktop starts at MAX_REPLAY already
  (api.getScrollbackSize as Mock).mockResolvedValue(MAX_REPLAY + 1_000_000);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));
  await tick();

  const term = instances[0];
  term.buffer.active.viewportY = 0;
  act(() => { term.fireScroll(); });
  await tick();
  expect(created).toHaveLength(1);
});

test('no rebuild when the delivered bytes already equal the reported total', async () => {
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(INITIAL_REPLAY_MOBILE); // no more history than requested
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));
  await tick();

  const term = instances[0];
  term.buffer.active.viewportY = 0;
  act(() => { term.fireScroll(); });
  await tick();
  expect(created).toHaveLength(1);
});

// ---- rebuild failure handling: abortable, self-clearing, never stuck ----
//
// A rebuild's new socket can die (error or close) before ever delivering its
// replay frame, or simply never deliver one (hang). All three must: clear the
// `rebuilding` guard, discard any buffered live frames, close only the NEW
// socket, and leave the OLD socket + current terminal content untouched — a
// failed speculative rebuild must never cost the user their existing view, and
// must never leave "load older" permanently dead for the rest of the session.

test('new socket closing before its replay arrives aborts the rebuild and preserves the current view', async () => {
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('INITIAL_REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));

  const term = instances[0];
  await waitFor(() => {
    term.buffer.active.viewportY = 0;
    act(() => { term.fireScroll(); });
    expect(created).toHaveLength(2);
  });

  // The new socket's underlying connection closes (cleanly) before it ever
  // delivers a replay frame.
  act(() => { created[1].opts.onClose?.(); });

  expect(created[1].close).toHaveBeenCalled();      // the failed socket is discarded
  expect(created[0].close).not.toHaveBeenCalled();   // the old socket survives untouched
  expect(term.written).toEqual(['INITIAL_REPLAY']);  // terminal content untouched — no reset, no partial write

  // Anti-stuck-flag: scrolling to the top again must start a fresh rebuild —
  // the `rebuilding` guard must have been cleared, not left permanently set.
  term.buffer.active.viewportY = 0;
  act(() => { term.fireScroll(); });
  expect(created).toHaveLength(3);
});

test('new socket erroring before its replay arrives aborts the rebuild and preserves the current view', async () => {
  // The socket abstraction (openTerminalSocket) has no separate "error" event —
  // a WebSocket error always surfaces through its close event (per the WHATWG
  // spec, a fatal error triggers the close algorithm), which is exactly what
  // `onClose` here represents. So a connection-refused / TLS failure / abrupt
  // network error on the new socket is exercised the same way as a graceful
  // close: both must abort the rebuild identically.
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('INITIAL_REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));

  const term = instances[0];
  await waitFor(() => {
    term.buffer.active.viewportY = 0;
    act(() => { term.fireScroll(); });
    expect(created).toHaveLength(2);
  });

  // Simulate an immediate connection error on the new socket (e.g. cellular
  // handoff killed it before the TCP/TLS handshake even completed) — surfaced
  // as onClose, per the note above.
  act(() => { created[1].opts.onClose?.(); });

  expect(created[1].close).toHaveBeenCalled();
  expect(created[0].close).not.toHaveBeenCalled();
  expect(term.written).toEqual(['INITIAL_REPLAY']);

  // Anti-stuck-flag.
  term.buffer.active.viewportY = 0;
  act(() => { term.fireScroll(); });
  expect(created).toHaveLength(3);
});

test('a rebuild that never delivers a replay times out (10s), aborts, and a later scroll starts a fresh rebuild', async () => {
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('INITIAL_REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));
  await tick(); // let the getScrollbackSize().then callback flip hasOlder=true (still real timers)

  const term = instances[0];
  term.buffer.active.viewportY = 0;

  // Only fake setTimeout/clearTimeout — leave Date, microtasks, and RAF alone so
  // the rest of the harness (xterm's queueMicrotask-based write, testing-library)
  // keeps working normally. Switched to fake BEFORE starting the rebuild so its
  // internal setTimeout(abort, 10_000) is the one we control below.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    act(() => { term.fireScroll(); }); // starts the rebuild synchronously
    expect(created).toHaveLength(2);

    // The new socket connects (already happened above) but never sends anything.
    act(() => { vi.advanceTimersByTime(10_000); });

    expect(created[1].close).toHaveBeenCalled();
    expect(created[0].close).not.toHaveBeenCalled();
    expect(term.written).toEqual(['INITIAL_REPLAY']);

    // Anti-stuck-flag: the guard was cleared by the timeout, not left stuck.
    term.buffer.active.viewportY = 0;
    act(() => { term.fireScroll(); });
    expect(created).toHaveLength(3);
  } finally {
    vi.useRealTimers();
  }
});

test('onReset firing on the primary socket mid-rebuild aborts the rebuild (discarding buffered frames) before the normal reset proceeds', async () => {
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('INITIAL_REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));

  const term = instances[0];
  await waitFor(() => {
    term.buffer.active.viewportY = 0;
    act(() => { term.fireScroll(); });
    expect(created).toHaveLength(2);
  });

  // Some live output arrives on the (still-primary) old socket while the
  // rebuild's new socket hasn't delivered its replay yet — this gets buffered
  // for eventual replay-then-catch-up ordering.
  act(() => { created[0].opts.onData('LIVE_BUFFERED'); });

  // Now the PRIMARY connection itself drops and auto-reconnects (the socket
  // module's own onReset, unrelated to the rebuild) WHILE the rebuild is still
  // in flight. This must abort the rebuild (discarding the buffered frame —
  // writing it after a reset would duplicate/interleave content) before doing
  // the ordinary reset-on-reconnect.
  act(() => { created[0].opts.onReset?.(); });

  expect(created[1].close).toHaveBeenCalled();      // the in-flight rebuild's new socket is discarded

  // Now that the primary has "reconnected" and reset, its next replay must land
  // clean — NOT preceded or followed by the discarded 'LIVE_BUFFERED' frame,
  // which would prove buffered content leaked across the reset.
  act(() => { created[0].opts.onData('FRESH_REPLAY'); });
  expect(term.written).toEqual(['INITIAL_REPLAY', 'FRESH_REPLAY']); // no 'LIVE_BUFFERED' anywhere

  // Anti-stuck-flag: a later scroll-to-top still starts a fresh rebuild.
  term.buffer.active.viewportY = 0;
  act(() => { term.fireScroll(); });
  expect(created).toHaveLength(3);
});

// ---- post-settle regressions: the promoted socket must stay ALIVE ----
//
// Every test above stops asserting at the moment the rebuild settles (old
// socket closed). These three cover what happens AFTER that point, which is
// exactly the gap that let two live defects ship: the promoted socket's
// onData handler still guarded on `settled` (dropping all future live
// frames forever), and the terminal's own onData kept sending typed input
// to the original (now-closed) socket instead of sockRef.current.

test('a live frame delivered to the promoted socket AFTER a rebuild settles is written to the terminal, not dropped', async () => {
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('INITIAL_REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));

  const term = instances[0];
  await waitFor(() => {
    term.buffer.active.viewportY = 0;
    act(() => { term.fireScroll(); });
    expect(created).toHaveLength(2);
  });

  // Deliver the new socket's replay frame and let the rebuild fully settle:
  // the old socket gets closed once finishRebuild() has run and promoted the
  // new socket to primary (sockRef.current = newSock).
  act(() => { created[1].opts.onData('REPLAY2'); });
  await waitFor(() => expect(created[0].close).toHaveBeenCalled());

  // The rebuild is now fully settled. A further live frame arrives on that
  // SAME (now-primary) socket — this must be written to the terminal like
  // any other live output, not silently swallowed because a one-shot
  // "settled" flag from the finished rebuild attempt is still gating it.
  act(() => { created[1].opts.onData('LIVE_AFTER_SETTLE'); });
  await tick();

  expect(term.written).toContain('LIVE_AFTER_SETTLE');
});

test('after a rebuild settles, typed input goes through the CURRENT primary socket, not the closed original', async () => {
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('INITIAL_REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));

  const term = instances[0];
  await waitFor(() => {
    term.buffer.active.viewportY = 0;
    act(() => { term.fireScroll(); });
    expect(created).toHaveLength(2);
  });

  act(() => { created[1].opts.onData('REPLAY2'); });
  await waitFor(() => expect(created[0].close).toHaveBeenCalled());

  // Rebuild settled: created[1] is now primary, created[0] is closed.
  // Simulate a keystroke typed directly into the terminal.
  act(() => { term.dataHandler?.('x'); });

  expect(created[1].send).toHaveBeenCalledWith('x');
  expect(created[0].send).not.toHaveBeenCalledWith('x');
});

// ---- scrollback-offset protocol: only a STRICTLY older window may replace the view ----
//
// Without the offset there is no way to tell whether a freshly replayed window is
// older, newer, or the very same bytes — yet the rebuild always reset the screen
// before writing it. The `dispatch:replay-meta` frame arrives BEFORE the replay
// bytes, so a worthless rebuild can be refused before anything is destroyed.

test('a rebuild whose replay is not older than the view aborts: no reset, no write, withheld output recovered', async () => {
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  // What is on screen begins 5000 bytes into the PTY's lifetime output.
  act(() => { created[0].opts.onMeta?.(meta(5000)); });
  act(() => { created[0].opts.onData('INITIAL_REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));

  const term = instances[0];
  const resetSpy = vi.spyOn(term, 'reset');
  await waitFor(() => {
    term.buffer.active.viewportY = 0;
    act(() => { term.fireScroll(); });
    expect(created).toHaveLength(2);
  });

  // Live output on the primary socket is withheld while the rebuild is in flight.
  act(() => { created[0].opts.onData('WITHHELD'); });

  // The larger request comes back starting at the SAME offset — the ring's head is
  // already on screen, so this window holds nothing older.
  act(() => { created[1].opts.onMeta?.(meta(5000, { complete: true })); });

  expect(created[1].close).toHaveBeenCalled();       // the pointless rebuild is discarded
  expect(created[0].close).not.toHaveBeenCalled();   // the old socket stays primary
  expect(resetSpy).not.toHaveBeenCalled();           // the view was never cleared
  // The old view survives and simply continues: its withheld frame is recovered.
  expect(term.written).toEqual(['INITIAL_REPLAY', 'WITHHELD']);

  // A replay frame the server had already queued before our close() landed must not
  // resurrect the aborted rebuild and blow away the view we just kept.
  act(() => { created[1].opts.onData('LATE_REPLAY'); });
  expect(resetSpy).not.toHaveBeenCalled();
  expect(term.written).toEqual(['INITIAL_REPLAY', 'WITHHELD']);

  // Nothing older exists, so scrolling to the top must stop offering it.
  term.buffer.active.viewportY = 0;
  act(() => { term.fireScroll(); });
  await tick();
  expect(created).toHaveLength(2);
});

test('a strictly older replay replaces the view, and its offset becomes the new floor', async () => {
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onMeta?.(meta(5000)); });
  act(() => { created[0].opts.onData('INITIAL_REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));

  const term = instances[0];
  await waitFor(() => {
    term.buffer.active.viewportY = 0;
    act(() => { term.fireScroll(); });
    expect(created).toHaveLength(2);
  });

  // 1000 < 5000: genuinely older history, so the rebuild proceeds as normal.
  act(() => { created[1].opts.onMeta?.(meta(1000)); });
  act(() => { created[1].opts.onData('OLDER_REPLAY'); });
  await waitFor(() => expect(created[0].close).toHaveBeenCalled());
  expect(term.written).toEqual(['INITIAL_REPLAY', 'OLDER_REPLAY']);

  // A later rebuild is compared against 1000 — the offset now on screen — not the
  // stale 5000. Same offset means nothing older, so it must abort.
  await waitFor(() => {
    term.buffer.active.viewportY = 0;
    act(() => { term.fireScroll(); });
    expect(created).toHaveLength(3);
  });
  act(() => { created[2].opts.onMeta?.(meta(1000)); });

  expect(created[2].close).toHaveBeenCalled();
  expect(created[1].close).not.toHaveBeenCalled(); // the promoted socket survives
  expect(term.written).toEqual(['INITIAL_REPLAY', 'OLDER_REPLAY']);
});

test('a successful rebuild tells the surviving socket to reconnect at the LARGER replay size', async () => {
  // Otherwise the next network blip reconnects at the original window and silently
  // throws away every line the reader just paged back to.
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('INITIAL_REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));

  const term = instances[0];
  await waitFor(() => {
    term.buffer.active.viewportY = 0;
    act(() => { term.fireScroll(); });
    expect(created).toHaveLength(2);
  });

  act(() => { created[1].opts.onData('REPLAY2'); });
  await waitFor(() => expect(created[0].close).toHaveBeenCalled());

  expect(created[1].setReplayBytes).toHaveBeenCalledWith(nextReplayStep(INITIAL_REPLAY_MOBILE));
});

// ---- xterm's own ceiling ----

test('no rebuild once xterm is at its scrollback cap — a bigger replay cannot show more', async () => {
  // xterm keeps at most `options.scrollback` lines and trims the head. At the cap a
  // bigger replay adds no visible history, but still resets the screen and (because
  // newLength - oldLength collapses to ~0) yanks the viewport to the top.
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('INITIAL_REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));
  await tick(); // let getScrollbackSize().then flip hasOlder=true

  const term = instances[0];
  const resetSpy = vi.spyOn(term, 'reset');
  // Saturated: the line buffer is sitting on the configured ceiling.
  term.options.scrollback = 100;
  term.buffer.active.length = 100;
  term.buffer.active.viewportY = 0;

  act(() => { term.fireScroll(); });
  await tick();

  // Identical to the "triggers exactly one rebuild" test above except for the cap,
  // which is the only reason no second socket exists here.
  expect(created).toHaveLength(1);
  expect(resetSpy).not.toHaveBeenCalled();
  expect(term.written).toEqual(['INITIAL_REPLAY']);
});

test('a rebuild still runs while the buffer is well under the scrollback cap', async () => {
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000);
  const { factory, created } = makeSocketFactory();

  render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('INITIAL_REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));
  await tick();

  const term = instances[0];
  term.options.scrollback = 100;
  term.buffer.active.length = 40; // plenty of room left
  term.buffer.active.viewportY = 0;

  act(() => { term.fireScroll(); });
  expect(created).toHaveLength(2);
});

test('unmounting mid-rebuild clears the pending stall timer — no abort fires after unmount', async () => {
  isMobileMock.mockReturnValue(true);
  (api.getScrollbackSize as Mock).mockResolvedValue(2_000_000);
  const { factory, created } = makeSocketFactory();

  const { unmount } = render(<TerminalTab terminalId="t1" socketFactory={factory as any} />);
  await waitFor(() => expect(created).toHaveLength(1));

  act(() => { created[0].opts.onData('INITIAL_REPLAY'); });
  await waitFor(() => expect(api.getScrollbackSize).toHaveBeenCalledWith('t1'));
  await tick(); // let getScrollbackSize().then flip hasOlder=true (still real timers)

  const term = instances[0];
  term.buffer.active.viewportY = 0;

  // Fake only setTimeout/clearTimeout, as the existing timeout test does, so
  // the rest of the harness (queueMicrotask-based fake write, RTL) is unaffected.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    act(() => { term.fireScroll(); }); // starts the rebuild; schedules the 10s stall timer
    expect(created).toHaveLength(2);

    act(() => { unmount(); }); // unmount mid-rebuild, before the replay ever lands
    const closeCallsAtUnmount = created[1].close.mock.calls.length;
    expect(closeCallsAtUnmount).toBeGreaterThanOrEqual(1); // cleanup closes the in-flight new socket

    // Advancing past the 10s stall timeout after unmount must be a no-op: no
    // throw, and no SECOND close from a stray abort() firing off a timer that
    // outlived the effect (which would also call a dead setLoadingOlder setter).
    expect(() => { act(() => { vi.advanceTimersByTime(10_000); }); }).not.toThrow();
    expect(created[1].close.mock.calls.length).toBe(closeCallsAtUnmount);
  } finally {
    vi.useRealTimers();
  }
});
