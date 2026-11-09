import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket, type WebSocketServer } from 'ws';
import { createClientWss } from './client-wss.js';

describe('createClientWss: permessage-deflate', () => {
  const servers: http.Server[] = [];
  const saved = process.env.DISPATCH_WS_DEFLATE;
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    if (saved === undefined) delete process.env.DISPATCH_WS_DEFLATE; else process.env.DISPATCH_WS_DEFLATE = saved;
  });

  /** Connects one client, receives one 4 KB text frame, and reports the extension and the bytes on the wire. */
  async function probe(wss: WebSocketServer): Promise<{ extensions: string; text: string; wireBytes: number }> {
    const payload = JSON.stringify({ type: 'assistant', text: 'the same words again and again. '.repeat(128) });
    const server = http.createServer();
    servers.push(server);
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => { ws.send(payload); ws.close(); }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/`);
    let text = '';
    let socket: import('node:net').Socket | undefined;
    ws.on('upgrade', (res) => { socket = res.socket; });
    ws.on('message', (d) => { text = d.toString(); });
    await new Promise((r, rej) => { ws.on('close', r); ws.on('error', rej); });
    expect(text).toBe(payload);
    return { extensions: ws.extensions, text, wireBytes: socket?.bytesRead ?? -1 };
  }

  it('the structured server negotiates permessage-deflate', async () => {
    delete process.env.DISPATCH_WS_DEFLATE;
    const r = await probe(createClientWss(undefined, { deflate: true }));
    expect(r.extensions).toContain('permessage-deflate');
    // No context is kept between messages: 30 sockets must not hold 30 zlib windows.
    expect(r.extensions).toContain('server_no_context_takeover');
    expect(r.extensions).toContain('client_no_context_takeover');
    expect(r.wireBytes).toBeLessThan(r.text.length / 2);
  });

  it('the terminal server does not', async () => {
    delete process.env.DISPATCH_WS_DEFLATE;
    const plain = await probe(createClientWss());
    expect(plain.extensions).toBe('');
    expect(plain.wireBytes).toBeGreaterThan(plain.text.length);
    const explicit = await probe(createClientWss(undefined, { deflate: false }));
    expect(explicit.extensions).toBe('');
  });

  it('DISPATCH_WS_DEFLATE=0 turns it off', async () => {
    process.env.DISPATCH_WS_DEFLATE = '0';
    const r = await probe(createClientWss(undefined, { deflate: true }));
    expect(r.extensions).toBe('');
  });

  it('a frame under 1 KB is sent as-is on a deflate server', async () => {
    delete process.env.DISPATCH_WS_DEFLATE;
    const wss = createClientWss(undefined, { deflate: true });
    expect((wss.options.perMessageDeflate as { threshold?: number }).threshold).toBe(1024);
  });
});
