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

function connect(pty: ReturnType<typeof fakePtyManager>) {
  const ws = fakeWs();
  const req = { url: '/api/terminals/t1/ws?replayBytes=1000000' } as IncomingMessage;
  handleTerminalConnection(ws as unknown as WebSocket, req, pty as unknown as PTYManager, sessionService);
  return ws;
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
