// W1-B: DISPATCH_BIND. Unset, the daemon listens on every interface as before. Set, it listens on that address
// (and still holds the loopback addresses, which the threads and the CLI use). An invalid value stops the start.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { LISTEN_FILE, listenOn, parseBindHost, readListenInfo, writeListenInfo } from '../../src/platform/bind.js';

describe('parseBindHost', () => {
  test('unset or empty means "no host": the old listen call', () => {
    expect(parseBindHost(undefined)).toBeUndefined();
    expect(parseBindHost('')).toBeUndefined();
    expect(parseBindHost('   ')).toBeUndefined();
  });
  test('an IP literal or localhost is accepted', () => {
    expect(parseBindHost('127.0.0.1')).toBe('127.0.0.1');
    expect(parseBindHost(' 127.0.0.1 ')).toBe('127.0.0.1');
    expect(parseBindHost('0.0.0.0')).toBe('0.0.0.0');
    expect(parseBindHost('100.64.0.9')).toBe('100.64.0.9');
    expect(parseBindHost('::1')).toBe('::1');
    expect(parseBindHost('[::1]')).toBe('::1');
    expect(parseBindHost('localhost')).toBe('localhost');
    expect(parseBindHost('LOCALHOST')).toBe('localhost');
  });
  test('an invalid value rejects with a clear message', () => {
    for (const bad of ['example.com', '127.0.0.1:3456', 'all', '999.1.1.1', '*', 'http://127.0.0.1']) {
      let err: Error | undefined;
      try { parseBindHost(bad); } catch (e) { err = e as Error; }
      expect(err, bad).toBeInstanceOf(Error);
      expect(err!.message).toContain('DISPATCH_BIND');
      expect(err!.message).toContain(JSON.stringify(bad));
      expect(err!.message).toMatch(/IP address .* or "localhost"/);
      // One line when the daemon prints it: no stack frames.
      expect(String(err!.stack)).not.toMatch(/\n\s+at /);
    }
  });
});

describe('listenOn', () => {
  const servers: http.Server[] = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });
  const listening = (host: string | undefined) => new Promise<http.Server>((resolve, reject) => {
    const s = http.createServer((_q, r) => r.end('ok'));
    servers.push(s);
    s.once('error', reject);
    listenOn(s, 0, host, () => resolve(s));
  });

  test('with DISPATCH_BIND=127.0.0.1 the server address is 127.0.0.1', async () => {
    const s = await listening(parseBindHost('127.0.0.1'));
    expect((s.address() as net.AddressInfo).address).toBe('127.0.0.1');
  });
  test('unset gives the old call', async () => {
    const s = http.createServer();
    servers.push(s);
    const spy = vi.spyOn(s, 'listen').mockImplementation((() => s) as any);
    const cb = () => {};
    listenOn(s, 4321, parseBindHost(undefined), cb);
    expect(spy).toHaveBeenCalledWith(4321, cb); // exactly (port, callback): no host argument
    listenOn(s, 4321, parseBindHost('127.0.0.1'), cb);
    expect(spy).toHaveBeenLastCalledWith(4321, '127.0.0.1', cb);
    spy.mockRestore();
    // And for real: the wildcard address.
    const real = await listening(undefined);
    expect(['::', '0.0.0.0']).toContain((real.address() as net.AddressInfo).address);
  });
});

describe('listen.json (what "dispatch status" reads)', () => {
  test('write then read gives the port, the pid and the bind address; a missing or broken file reads as null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-listen-'));
    try {
      expect(readListenInfo(dir)).toBeNull();
      writeListenInfo(dir, { port: 4000, bind: null }, 77);
      expect(readListenInfo(dir)).toEqual({ pid: 77, port: 4000, bind: null });
      writeListenInfo(dir, { port: 4000, bind: '127.0.0.1' }, 78);
      expect(readListenInfo(dir)).toEqual({ pid: 78, port: 4000, bind: '127.0.0.1' });
      fs.writeFileSync(path.join(dir, LISTEN_FILE), '{nope');
      expect(readListenInfo(dir)).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// A real daemon (own HOME, random port), so the listen block of startServer runs.
describe('the daemon', () => {
  let child: ChildProcess | undefined;
  let home = '';
  afterEach(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child!.once('exit', r));
      child.kill('SIGTERM');
      setTimeout(() => child?.kill('SIGKILL'), 5000).unref();
      await exited;
    }
    child = undefined;
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  function start(bind: string | undefined): { port: number; out: () => string; exited: Promise<number | null> } {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-bind-'));
    // Below the OS ephemeral range (49152 and up on macOS): with DISPATCH_BIND the daemon holds no wildcard socket, and
    // the kernel could hand the same port number to another test's `listen(0)` server.
    const port = 20000 + Math.floor(Math.random() * 19000);
    let output = '';
    // The same catch as the direct run at the end of server.ts.
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `globalThis.fetch = async () => { throw new Error('offline test'); }; const { startServer } = await import('./src/server.ts'); startServer({port:${port}}).catch((err) => { console.error('Failed to start server:', err); process.exit(1); });`], {
      cwd: path.resolve(import.meta.dirname, '..', '..'),
      env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, SHELL: '/bin/sh', DISPATCH_TELEMETRY: '0', ...(bind === undefined ? {} : { DISPATCH_BIND: bind }) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (d) => { output += d; });
    child.stderr!.on('data', (d) => { output += d; });
    const exited = new Promise<number | null>((r) => child!.once('exit', r));
    return { port, out: () => output, exited };
  }
  const up = (out: () => string) => new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { clearInterval(poll); reject(new Error(out())); }, 20000);
    const poll = setInterval(() => { if (/listening on port/.test(out())) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 25);
  });
  /** Does a TCP connect to host:port succeed? */
  const connects = (host: string, port: number) => new Promise<boolean>((resolve) => {
    const s = net.connect({ host, port });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(1500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
  /** An IPv4 address of this machine that is not loopback, when it has one. */
  const lanAddress = (): string | undefined => Object.values(os.networkInterfaces()).flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

  test('with DISPATCH_BIND=127.0.0.1 the daemon answers on loopback only, says so, and writes the address for "dispatch status"', async () => {
    const d = start('127.0.0.1');
    await up(d.out);
    expect(await connects('127.0.0.1', d.port)).toBe(true);
    const lan = lanAddress();
    if (lan) expect(await connects(lan, d.port), `the LAN address ${lan} must not answer`).toBe(false);
    expect(d.out()).toMatch(/DISPATCH_BIND: listens on 127\.0\.0\.1/);
    // The loopback guard must not report our own listener as another process.
    expect(d.out()).not.toMatch(/held by another process/);
    expect(readListenInfo(path.join(home, '.dispatch'))).toMatchObject({ port: d.port, bind: '127.0.0.1', pid: child!.pid });
  }, 40000);

  test('unset: the daemon listens on every interface, as before', async () => {
    const d = start(undefined);
    await up(d.out);
    expect(await connects('127.0.0.1', d.port)).toBe(true);
    const lan = lanAddress();
    if (lan) expect(await connects(lan, d.port), `the LAN address ${lan} must answer`).toBe(true);
    expect(d.out()).not.toMatch(/DISPATCH_BIND/);
    expect(readListenInfo(path.join(home, '.dispatch'))).toMatchObject({ port: d.port, bind: null });
  }, 40000);

  test('an invalid value stops the start with one clear error line, before anything listens', async () => {
    const d = start('not-an-address');
    const code = await Promise.race([d.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20000))]);
    expect(code).toBe(1);
    const lines = d.out().split('\n').filter((l) => /DISPATCH_BIND/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Failed to start server: .*DISPATCH_BIND="not-an-address" is not valid/);
    expect(d.out()).not.toMatch(/\n\s+at /); // no stack trace
    expect(d.out()).not.toMatch(/listening on port/);
    expect(await connects('127.0.0.1', d.port)).toBe(false);
    // Nothing was made in the data dir: the check runs before the database opens.
    expect(fs.existsSync(path.join(home, '.dispatch', 'dispatch.db'))).toBe(false);
  }, 40000);
});
