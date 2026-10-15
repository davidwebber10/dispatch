import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import net from 'net';
import { guardLoopback } from '../../src/platform/loopback-guard.js';

const open: { close: () => void }[] = [];
afterEach(() => { for (const s of open.splice(0)) try { s.close(); } catch { /* */ } });

const listen = (s: net.Server, port: number, host?: string) => new Promise<void>((res, rej) => { s.once('error', rej); s.listen(port, host, () => res()); });
const get = (url: string) => new Promise<string>((res, rej) => http.get(url, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b)); }).on('error', rej));

describe('guardLoopback', () => {
  it('after it runs, another process cannot take 127.0.0.1 on the port, and 127.0.0.1 still reaches the daemon', async () => {
    const server = http.createServer((_req, res) => res.end('dispatch'));
    open.push(server);
    await listen(server, 0);
    const port = (server.address() as net.AddressInfo).port;
    open.push(...(await guardLoopback(server, port)));
    const intruder = net.createServer();
    open.push(intruder);
    await expect(listen(intruder, port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(await get(`http://127.0.0.1:${port}/`)).toBe('dispatch');
  });

  it('warns when another process already holds 127.0.0.1 on the port', async () => {
    const server = http.createServer((_req, res) => res.end('dispatch'));
    open.push(server);
    await listen(server, 0);
    const port = (server.address() as net.AddressInfo).port;
    const squatter = net.createServer();
    open.push(squatter);
    let squatted = true;
    try { await listen(squatter, port, '127.0.0.1'); } catch { squatted = false; } // Linux refuses it outright
    const warnings: string[] = [];
    open.push(...(await guardLoopback(server, port, (m) => warnings.push(m))));
    if (squatted) expect(warnings.join('\n')).toMatch(/127\.0\.0\.1:\d+ is held by another process/);
  });
});
