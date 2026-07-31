import { describe, it, expect, vi } from 'vitest';
import { handleTerminalConnection } from '../../src/ws/terminal.js';
import type { PTYManager } from '../../src/pty/manager.js';
import type { SessionService } from '../../src/sessions/service.js';
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'http';

function fakeWs() {
  return {
    sent: [] as unknown[],
    readyState: 1,
    send(data: unknown) { this.sent.push(data); },
    close: vi.fn(),
    on: vi.fn(),
  };
}

function fakePtyManager(over: Partial<Record<string, unknown>> = {}) {
  return {
    isAlive: () => true,
    getBuffer: () => 'replayed-bytes',
    getBufferSlice: vi.fn(() => ({ data: 'sliced-bytes', startOffset: 4096 })),
    getBufferOffsets: vi.fn(() => ({ startOffset: 1024, totalWritten: 999999 })),
    isReplayComplete: () => true,
    nudgeRepaint: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    ...over,
  };
}

const sessionService = {
  getTerminal: () => ({ id: 't1', type: 'codex' }),
} as unknown as SessionService;

function connect(pty: ReturnType<typeof fakePtyManager>, url = '/api/terminals/t1/ws?replayBytes=1000000') {
  const ws = fakeWs();
  const req = { url } as IncomingMessage;
  handleTerminalConnection(ws as unknown as WebSocket, req, pty as unknown as PTYManager, sessionService);
  return ws;
}

/** Frames the client would have to parse as JSON control frames. */
function controlFrames(ws: ReturnType<typeof fakeWs>) {
  return ws.sent.filter((f) => {
    if (typeof f !== 'string') return false;
    try { return typeof JSON.parse(f) === 'object' && JSON.parse(f) !== null; } catch { return false; }
  });
}

describe('handleTerminalConnection replay', () => {
  it('sends the replay buffer without a nudge when it is complete', () => {
    const pty = fakePtyManager();
    const ws = connect(pty);
    expect(ws.sent).toEqual(['replayed-bytes']);
    expect(pty.nudgeRepaint).not.toHaveBeenCalled();
  });

  it('nudges a full repaint when the replay is incomplete', () => {
    const pty = fakePtyManager({ isReplayComplete: () => false });
    const ws = connect(pty);
    expect(ws.sent).toEqual(['replayed-bytes']);
    expect(pty.nudgeRepaint).toHaveBeenCalledWith('t1');
  });
});

describe('handleTerminalConnection replay meta (scrollback-offset protocol)', () => {
  it('sends exactly one dispatch:replay-meta frame BEFORE the replay bytes when meta=1', () => {
    const pty = fakePtyManager();
    const ws = connect(pty, '/api/terminals/t1/ws?replayBytes=1000000&meta=1');

    expect(ws.sent).toEqual([
      JSON.stringify({ type: 'dispatch:replay-meta', startOffset: 4096, totalWritten: 999999, complete: true }),
      'sliced-bytes',
    ]);
    expect(controlFrames(ws)).toHaveLength(1);
    // startOffset comes from the SLICE (first real replayed byte), not from the ring head.
    expect(JSON.parse(ws.sent[0] as string).startOffset).toBe(4096);
    expect(pty.getBufferSlice).toHaveBeenCalledWith('t1', 1000000);
  });

  it('reports complete:false and still nudges when the replay is trimmed', () => {
    const pty = fakePtyManager({ isReplayComplete: () => false });
    const ws = connect(pty, '/api/terminals/t1/ws?replayBytes=1000&meta=1');
    expect(JSON.parse(ws.sent[0] as string).complete).toBe(false);
    expect(ws.sent[1]).toBe('sliced-bytes');
    expect(pty.nudgeRepaint).toHaveBeenCalledWith('t1');
  });

  it('sends the meta frame even when there is nothing to replay', () => {
    const pty = fakePtyManager({ getBufferSlice: () => ({ data: '', startOffset: 0 }) });
    const ws = connect(pty, '/api/terminals/t1/ws?meta=1');
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0] as string)).toEqual({
      type: 'dispatch:replay-meta', startOffset: 0, totalWritten: 999999, complete: true,
    });
  });

  it('sends ZERO control frames when meta is absent — the back-compat guarantee', () => {
    for (const url of ['/api/terminals/t1/ws', '/api/terminals/t1/ws?replayBytes=1000000', '/api/sessions/t1/terminal']) {
      const pty = fakePtyManager();
      const ws = connect(pty, url);
      expect(controlFrames(ws)).toEqual([]);
      expect(ws.sent).toEqual(['replayed-bytes']); // exactly today's stream, nothing else
      expect(pty.getBufferSlice).not.toHaveBeenCalled();
    }
  });

  it('ignores a meta param that is not opting in (meta=0)', () => {
    const pty = fakePtyManager();
    const ws = connect(pty, '/api/terminals/t1/ws?meta=0');
    expect(controlFrames(ws)).toEqual([]);
    expect(ws.sent).toEqual(['replayed-bytes']);
  });
});

describe('handleTerminalConnection activity suppression', () => {
  it('suppresses the monitor on attach and on client resize', () => {
    const pty = fakePtyManager();
    const monitor = { suppress: vi.fn() };
    const ws = fakeWs();
    const req = { url: '/api/terminals/t1/ws' } as IncomingMessage;
    handleTerminalConnection(ws as unknown as WebSocket, req, pty as unknown as PTYManager, sessionService, monitor as any);
    expect(monitor.suppress).toHaveBeenCalledWith('t1');

    const onMessage = ws.on.mock.calls.find((c) => c[0] === 'message')![1];
    monitor.suppress.mockClear();
    onMessage(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    expect(monitor.suppress).toHaveBeenCalledWith('t1');
    expect(pty.resize).toHaveBeenCalledWith('t1', 80, 24);
  });

  it('works without a monitor (backwards compatible)', () => {
    const pty = fakePtyManager();
    expect(() => connect(pty)).not.toThrow();
  });
});
