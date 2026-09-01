import { describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import { handleTerminalConnection } from './terminal.js';
import type { PTYManager } from '../pty/manager.js';

/** Order-sensitive fake: records every call so a test can assert the pty was
 *  resized BEFORE the replay buffer was read. */
function fakes(size: { cols: number; rows: number } | null = { cols: 250, rows: 50 }) {
  const calls: string[] = [];
  const pty = Object.assign(new EventEmitter(), {
    isAlive: () => true,
    getSize: vi.fn(() => size),
    resize: vi.fn((_id: string, _c: number, _r: number) => { calls.push('resize'); }),
    getBuffer: vi.fn(() => { calls.push('getBuffer'); return 'replay-bytes'; }),
    getBufferSlice: vi.fn(() => { calls.push('getBufferSlice'); return { data: 'replay-bytes', startOffset: 0 }; }),
    getBufferOffsets: vi.fn(() => ({ startOffset: 0, totalWritten: 12 })),
    isReplayComplete: vi.fn(() => true),
    nudgeRepaint: vi.fn(),
    write: vi.fn(),
  }) as unknown as PTYManager;
  const sent: string[] = [];
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    send: (d: string) => sent.push(d),
    close: vi.fn(),
  }) as unknown as WebSocket;
  return { pty, ws, sent, calls };
}

const req = (url: string) => ({ url }) as IncomingMessage;

describe('declared viewer size on the terminal ws URL', () => {
  test('a differing declared size resizes the pty BEFORE the replay is read', () => {
    const { pty, ws, calls } = fakes({ cols: 250, rows: 50 });
    handleTerminalConnection(ws, req('/api/terminals/t1/ws?replayBytes=1000&cols=90&rows=40'), pty);
    expect((pty as any).resize).toHaveBeenCalledWith('t1', 90, 40);
    expect(calls.indexOf('resize')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('resize')).toBeLessThan(calls.indexOf('getBuffer'));
  });

  test('a matching declared size does not resize', () => {
    const { pty, ws } = fakes({ cols: 90, rows: 40 });
    handleTerminalConnection(ws, req('/api/terminals/t1/ws?cols=90&rows=40'), pty);
    expect((pty as any).resize).not.toHaveBeenCalled();
  });

  test('absent or garbage size params keep the historical order (no resize)', () => {
    for (const q of ['', '&cols=abc&rows=40', '&cols=0&rows=40', '&cols=90', '&cols=-5&rows=2']) {
      const { pty, ws } = fakes({ cols: 250, rows: 50 });
      handleTerminalConnection(ws, req(`/api/terminals/t1/ws?replayBytes=1000${q}`), pty);
      expect((pty as any).resize).not.toHaveBeenCalled();
    }
  });

  test('no live pty (getSize null) → no resize attempt', () => {
    const { pty, ws } = fakes(null);
    handleTerminalConnection(ws, req('/api/terminals/t1/ws?cols=90&rows=40'), pty);
    expect((pty as any).resize).not.toHaveBeenCalled();
  });

  test('the replay still flows to the client after a declared-size resize', () => {
    const { pty, ws, sent } = fakes({ cols: 250, rows: 50 });
    handleTerminalConnection(ws, req('/api/terminals/t1/ws?cols=90&rows=40'), pty);
    expect(sent).toContain('replay-bytes');
  });
});
