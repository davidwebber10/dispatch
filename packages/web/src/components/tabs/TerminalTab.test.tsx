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
    private scrollHandlers: Array<() => void> = [];
    constructor() { instances.push(this); }
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    onData() { return { dispose() {} }; }
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

type FakeOpts = { terminalId: string; replayBytes?: number; onData: (c: string) => void; onReset?: () => void; onClose?: () => void };

function makeSocketFactory() {
  const created: { opts: FakeOpts; close: Mock; send: Mock; resize: Mock }[] = [];
  const factory = (opts: FakeOpts) => {
    const entry = { opts, close: vi.fn(), send: vi.fn(), resize: vi.fn() };
    created.push(entry);
    return { send: entry.send, resize: entry.resize, close: entry.close };
  };
  return { factory, created };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  instances.length = 0;
  isMobileMock.mockReturnValue(false);
  vi.spyOn(api, 'getTerminal').mockResolvedValue({ id: 't1', sessionId: 's1', workingDir: '/p/x', pid: 4242, status: 'working' } as any);
  vi.spyOn(api, 'getGitInfo').mockResolvedValue({ branch: 'main' });
  vi.spyOn(api, 'getScrollbackSize').mockResolvedValue(0);
});
afterEach(() => vi.restoreAllMocks());

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
  act(() => {
    created[1].opts.onData('REPLAY2');
    created[0].opts.onData('LIVE_OLD');
    created[1].opts.onData('LIVE_NEW');
  });

  // Rebuild completes (old socket closed) once everything has drained.
  await waitFor(() => expect(created[0].close).toHaveBeenCalled());

  expect(term.written).toEqual(['INITIAL_REPLAY', 'REPLAY2', 'LIVE_OLD', 'LIVE_NEW']);
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
