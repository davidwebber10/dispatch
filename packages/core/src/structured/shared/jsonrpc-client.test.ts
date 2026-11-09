// packages/core/src/structured/shared/jsonrpc-client.test.ts
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { JsonRpcStdioClient, type JsonRpcChild } from './jsonrpc-client.js';

/** A fake child process: the test reads what the client wrote to stdin and writes lines to stdout. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & JsonRpcChild & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; killed: string[] };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.killed = [];
  child.kill = ((signal?: string) => { child.killed.push(signal ?? 'SIGTERM'); return true; }) as JsonRpcChild['kill'];
  const written: any[] = [];
  let buf = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) { written.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); }
  });
  const say = (obj: unknown) => child.stdout.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n');
  return { child, written, say };
}
const tick = () => new Promise((r) => setTimeout(r, 15));

describe('JsonRpcStdioClient', () => {
  it('request resolves with the matching id', async () => {
    const { child, written, say } = fakeChild();
    const client = new JsonRpcStdioClient(child);
    const a = client.request<{ n: number }>('first', { x: 1 });
    const b = client.request<{ n: number }>('second');
    await tick();
    expect(written).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'first', params: { x: 1 } },
      { jsonrpc: '2.0', id: 2, method: 'second' },
    ]);
    say({ jsonrpc: '2.0', id: 2, result: { n: 22 } }); // answered out of order
    say({ jsonrpc: '2.0', id: 1, result: { n: 11 } });
    expect(await a).toEqual({ n: 11 });
    expect(await b).toEqual({ n: 22 });
  });

  it('an error answer rejects with the class the owner chose', async () => {
    class Refused extends Error {}
    const { child, say } = fakeChild();
    const client = new JsonRpcStdioClient(child, { rpcError: (message) => new Refused(message) });
    const p = client.request('turn/start');
    await tick();
    say({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'unknown model' } });
    await expect(p).rejects.toBeInstanceOf(Refused);
    await expect(p).rejects.toThrow('unknown model');
  });

  it('request rejects after the timeout', async () => {
    const { child, say } = fakeChild();
    const client = new JsonRpcStdioClient(child, { messages: { timeout: (method) => `no answer to ${method}` } });
    await expect(client.request('slow', {}, 30)).rejects.toThrow('no answer to slow');
    // A late answer for the dropped request is ignored; the client still works.
    say({ jsonrpc: '2.0', id: 1, result: 'late' });
    const next = client.request('fast');
    await tick();
    say({ jsonrpc: '2.0', id: 2, result: 'ok' });
    expect(await next).toBe('ok');
  });

  it('a server request is emitted and respond writes the answer', async () => {
    const { child, written, say } = fakeChild();
    const client = new JsonRpcStdioClient(child);
    const requests: unknown[][] = [];
    const notifications: unknown[][] = [];
    client.on('request', (method, id, params) => requests.push([method, id, params]));
    client.on('notification', (method, params) => notifications.push([method, params]));
    say({ jsonrpc: '2.0', id: 'srv-7', method: 'item/approve', params: { item: 1 } });
    say({ jsonrpc: '2.0', method: 'turn/started', params: { turn: 't' } });
    say({ jsonrpc: '2.0', method: 'bare' });
    await tick();
    expect(requests).toEqual([['item/approve', 'srv-7', { item: 1 }]]);
    expect(notifications).toEqual([['turn/started', { turn: 't' }], ['bare', {}]]);
    client.respond('srv-7', { decision: 'accept' });
    client.respondError(9, -32601, 'unhandled server request');
    client.notify('initialized');
    await tick();
    expect(written).toEqual([
      { jsonrpc: '2.0', id: 'srv-7', result: { decision: 'accept' } },
      { jsonrpc: '2.0', id: 9, error: { code: -32601, message: 'unhandled server request' } },
      { jsonrpc: '2.0', method: 'initialized' },
    ]);
  });

  it('a non-JSON line is skipped', async () => {
    const { child, say } = fakeChild();
    const client = new JsonRpcStdioClient(child);
    const notifications: string[] = [];
    client.on('notification', (method) => notifications.push(method));
    say('warning: something that is not JSON');
    say('{ broken');
    say('');
    say({ jsonrpc: '2.0', method: 'after' });
    await tick();
    expect(notifications).toEqual(['after']);
    expect(client.skippedLines).toBe(2); // counted; the empty line is not a line at all
  });

  it('exit rejects every pending request', async () => {
    const { child } = fakeChild();
    const client = new JsonRpcStdioClient(child, { messages: { exited: 'app-server exited', notConnected: 'app-server not connected' } });
    const exits: number[] = [];
    client.on('exit', (code) => exits.push(code));
    const a = client.request('one');
    const b = client.request('two', {}, 5_000);
    child.emit('exit', 3);
    await expect(a).rejects.toThrow('app-server exited');
    await expect(b).rejects.toThrow('app-server exited');
    expect(exits).toEqual([3]);
    expect(client.alive).toBe(false);
    await expect(client.request('three')).rejects.toThrow('app-server not connected');
  });

  it('stderr is read and emitted, and a spawn error is passed on', async () => {
    const { child } = fakeChild();
    const client = new JsonRpcStdioClient(child);
    const chunks: string[] = [];
    const errors: unknown[] = [];
    client.on('stderr', (text) => chunks.push(text));
    client.on('spawn-error', (err) => errors.push(err));
    child.stderr.write('boom\n');
    child.emit('error', new Error('ENOENT'));
    await tick();
    expect(chunks.join('')).toBe('boom\n');
    expect(String(errors[0])).toContain('ENOENT');
  });

  it('start runs the handshake and ready settles with it; close stops the child', async () => {
    const { child, written, say } = fakeChild();
    const client = new JsonRpcStdioClient(child);
    client.start(async (c) => { await c.request('initialize', { v: 1 }); c.notify('initialized'); });
    await tick();
    say({ jsonrpc: '2.0', id: 1, result: {} });
    await client.ready;
    expect(written.map((w) => w.method)).toEqual(['initialize', 'initialized']);
    expect(client.pid).toBe(4242);
    client.close();
    expect(client.alive).toBe(false);
    expect(child.killed).toEqual(['SIGTERM']);
    client.notify('ignored after close');
    await tick();
    expect(written).toHaveLength(2);

    const failing = fakeChild();
    const c2 = new JsonRpcStdioClient(failing.child);
    c2.start(async (c) => { await c.request('initialize'); });
    failing.child.emit('exit', 1);
    await expect(c2.ready).rejects.toThrow();
  });
});
