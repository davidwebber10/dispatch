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


// ---- W2-I: the replay frame is compressed, live output is not ----
describe('terminal socket compression', () => {
  async function run(wssFactory: () => Promise<import('ws').WebSocketServer>, query: string) {
    const http = await import('node:http');
    const { WebSocket: Client } = await import('ws');
    const replay = Array.from({ length: 4000 }, (_, i) => `\u001b[32mline ${i}\u001b[0m some terminal output that repeats\r\n`).join('');
    const live = 'live output that repeats and repeats. '.repeat(120); // 4.5 KB: over the 1 KB threshold
    const pty = Object.assign(new EventEmitter(), {
      isAlive: () => true, getSize: () => null, resize: vi.fn(),
      getBuffer: () => replay,
      getBufferSlice: () => ({ data: replay, startOffset: 0 }),
      getBufferOffsets: () => ({ startOffset: 0, totalWritten: replay.length }),
      isReplayComplete: () => true, nudgeRepaint: vi.fn(), write: vi.fn(),
    }) as unknown as PTYManager;
    const wss = await wssFactory();
    const server = http.createServer();
    server.on('upgrade', (rq, socket, head) => wss.handleUpgrade(rq, socket, head, (sock) => handleTerminalConnection(sock, rq, pty)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const c = new Client(`ws://127.0.0.1:${port}/api/terminals/t1/ws${query}`);
    const got: string[] = [];
    let socket: import('node:net').Socket | undefined;
    let extensions = '';
    c.on('upgrade', (res) => { socket = res.socket; extensions = String(res.headers['sec-websocket-extensions'] ?? ''); });
    c.on('message', (d) => got.push(d.toString()));
    await new Promise((r) => c.on('open', r));
    const wait = async (n: number) => { for (let i = 0; i < 200 && got.length < n; i++) await new Promise((r) => setTimeout(r, 10)); };
    await wait(query.includes('meta=1') ? 2 : 1);
    const afterReplay = socket!.bytesRead;
    (pty as unknown as EventEmitter).emit('data', 't1', live);
    await wait(got.length + 1);
    const afterLive = socket!.bytesRead;
    c.close(); server.close();
    return { got, replay, live, extensions, replayWire: afterReplay, liveWire: afterLive - afterReplay };
  }
  const defaultWss = async () => (await import('./client-wss.js')).createClientWss();

  test('the replay frame is compressed and a live frame is not', async () => {
    const r = await run(defaultWss, '?replayBytes=1000000');
    expect(r.extensions).toContain('permessage-deflate');
    // Byte-for-byte the same replay after the compression, then the live frame.
    expect(r.got).toEqual([r.replay, r.live]);
    expect(r.replayWire).toBeLessThan(r.replay.length / 5);
    expect(r.liveWire).toBeGreaterThanOrEqual(r.live.length);
    console.log(`[w2-i] terminal replay of ${r.replay.length} bytes: ${r.replayWire} bytes on the wire`);
  });

  test('with meta=1 the control frame comes first and the replay is still byte-for-byte', async () => {
    const r = await run(defaultWss, '?replayBytes=1000000&meta=1');
    expect(JSON.parse(r.got[0]).type).toBe('dispatch:replay-meta');
    expect(r.got.slice(1)).toEqual([r.replay, r.live]);
  });

  test('a 4 MB replay with multi-byte text and escape sequences survives the compression byte-for-byte', async () => {
    const http = await import('node:http');
    const { WebSocket: Client } = await import('ws');
    const { createClientWss } = await import('./client-wss.js');
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const parts: string[] = [];
    let size = 0;
    while (size < 4_000_000) {
      const p = rnd() < 0.3 ? `\u001b[${Math.floor(rnd() * 100)};${Math.floor(rnd() * 200)}H` : rnd() < 0.5 ? '日本語のテキスト └─┬─┘ ✓ ' : `plain ${Math.floor(rnd() * 1e9).toString(36)}\r\n`;
      parts.push(p); size += p.length;
    }
    const replay = parts.join('');
    const pty = Object.assign(new EventEmitter(), {
      isAlive: () => true, getSize: () => null, resize: vi.fn(), getBuffer: () => replay,
      isReplayComplete: () => true, nudgeRepaint: vi.fn(), write: vi.fn(),
    }) as unknown as PTYManager;
    const wss = createClientWss();
    const server = http.createServer();
    server.on('upgrade', (rq, socket, head) => wss.handleUpgrade(rq, socket, head, (sock) => handleTerminalConnection(sock, rq, pty)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const c = new Client(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/terminals/t1/ws`);
    const first = await new Promise<string>((r) => c.once('message', (d) => r(d.toString())));
    c.close(); server.close();
    expect(first.length).toBe(replay.length);
    expect(first === replay).toBe(true);
  });

  test('a client that does not offer the extension gets the same bytes, not compressed', async () => {
    const http = await import('node:http');
    const { WebSocket: Client } = await import('ws');
    const { createClientWss } = await import('./client-wss.js');
    const { pty } = fakes();
    const wss = createClientWss();
    const server = http.createServer();
    server.on('upgrade', (rq, socket, head) => wss.handleUpgrade(rq, socket, head, (sock) => handleTerminalConnection(sock, rq, pty)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const c = new Client(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/terminals/t1/ws`, { perMessageDeflate: false });
    let extensions = 'unset';
    c.on('upgrade', (res) => { extensions = String(res.headers['sec-websocket-extensions'] ?? ''); });
    const first = await new Promise<string>((r) => c.once('message', (d) => r(d.toString())));
    c.close(); server.close();
    expect(extensions).toBe('');
    expect(first).toBe('replay-bytes');
  });

  test('DISPATCH_WS_DEFLATE=0 keeps the terminal socket as it was', async () => {
    process.env.DISPATCH_WS_DEFLATE = '0';
    try {
      const r = await run(defaultWss, '');
      expect(r.extensions).toBe('');
      expect(r.got).toEqual([r.replay, r.live]);
    } finally { delete process.env.DISPATCH_WS_DEFLATE; }
  });
});
