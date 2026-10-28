// SEC-23: a small JSON cap on every route; the large cap only on the routes that carry big payloads.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { maxJsonBytes, maxLargeJsonBytes, wsMaxPayload, wsTerminalMaxPayload } from '../../src/caps.js';

describe('request body caps', () => {
  let app: any;
  let dir: string;
  beforeEach(() => {
    const db = new Database(':memory:');
    initSchema(db);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-body-'));
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'test', workingDir: dir });
    app = createApp({ db, skipPty: true });
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const big = (bytes: number) => ({ content: 'x'.repeat(bytes) });

  it('defaults: 1 MiB for a normal route, 50 MiB for the large ones, 1 MiB per socket message', () => {
    expect(maxJsonBytes()).toBe(1024 * 1024);
    expect(maxLargeJsonBytes()).toBe(50 * 1024 * 1024);
    expect(wsMaxPayload()).toBe(1024 * 1024);
    expect(wsTerminalMaxPayload()).toBe(8 * 1024 * 1024); // a whole paste is one message
  });

  it('a normal route refuses a body over 1 MiB with 413, and takes a smaller one', async () => {
    const tooBig = await request(app).post('/api/sessions/s1/files/mkdir?path=a').send(big(1.5 * 1024 * 1024));
    expect(tooBig.status).toBe(413);
    const ok = await request(app).post('/api/sessions/s1/files/mkdir?path=a').send(big(200 * 1024));
    expect(ok.status).toBe(200);
  });

  it('the hook route (events), the file editor save and the thread message accept a body over 1 MiB', async () => {
    const hook = await request(app).post('/api/events/claude/t-none').send({ hook_event_name: 'PostToolUse', tool_response: 'x'.repeat(3 * 1024 * 1024) });
    expect(hook.status).toBe(204);
    const save = await request(app).put('/api/sessions/s1/files/write?path=big.txt').send(big(3 * 1024 * 1024));
    expect(save.status).toBe(200);
    expect(fs.statSync(path.join(dir, 'big.txt')).size).toBe(3 * 1024 * 1024);
    const msg = await request(app).post('/api/terminals/none/message').send({ content: [{ type: 'image', data: 'x'.repeat(3 * 1024 * 1024) }] });
    expect(msg.status).not.toBe(413); // 404 for an unknown thread: the body was read
  });

  it('the cap is read from DISPATCH_MAX_JSON_BYTES', async () => {
    const prev = process.env.DISPATCH_MAX_JSON_BYTES;
    process.env.DISPATCH_MAX_JSON_BYTES = '2048';
    try {
      const db = new Database(':memory:'); initSchema(db);
      const small = createApp({ db, skipPty: true });
      expect((await request(small).post('/api/sessions/none/files/mkdir?path=a').send(big(4096))).status).toBe(413);
    } finally { if (prev === undefined) delete process.env.DISPATCH_MAX_JSON_BYTES; else process.env.DISPATCH_MAX_JSON_BYTES = prev; }
  });

  it('a bad or negative value falls back to the default', () => {
    const prev = process.env.DISPATCH_WS_MAX_PAYLOAD;
    try {
      process.env.DISPATCH_WS_MAX_PAYLOAD = 'abc'; expect(wsMaxPayload()).toBe(1024 * 1024);
      process.env.DISPATCH_WS_MAX_PAYLOAD = '-1'; expect(wsMaxPayload()).toBe(1024 * 1024);
      process.env.DISPATCH_WS_MAX_PAYLOAD = '4096'; expect(wsMaxPayload()).toBe(4096);
    } finally { if (prev === undefined) delete process.env.DISPATCH_WS_MAX_PAYLOAD; else process.env.DISPATCH_WS_MAX_PAYLOAD = prev; }
  });
});

describe('websocket message cap', () => {
  it('closes a socket that sends a message over the cap, and keeps one that stays under it', async () => {
    const http = await import('node:http');
    const { WebSocket } = await import('ws');
    const { createClientWss } = await import('../../src/ws/client-wss.js');
    const prev = process.env.DISPATCH_WS_MAX_PAYLOAD;
    process.env.DISPATCH_WS_MAX_PAYLOAD = '4096';
    const wss = createClientWss();
    const received: number[] = [];
    wss.on('connection', (ws) => ws.on('message', (m) => received.push((m as Buffer).length)));
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as import('node:net').AddressInfo).port;
    try {
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((r) => client.on('open', () => r()));
      client.send('x'.repeat(1000));
      client.send('x'.repeat(10_000));
      const code = await new Promise<number>((r) => client.on('close', (c) => r(c)));
      expect(code).toBe(1009);
      expect(received).toEqual([1000]);
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_WS_MAX_PAYLOAD; else process.env.DISPATCH_WS_MAX_PAYLOAD = prev;
      wss.close(); server.close();
    }
  });
});
