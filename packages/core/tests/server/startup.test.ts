// W3-A: startServer is build, attach, listen, start timers, boot recover. A real daemon (own HOME, own port,
// bound to 127.0.0.1) answers, and stops cleanly on SIGTERM.
import { afterEach, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let child: ChildProcess | undefined;
let home = '';
afterEach(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child!.once('exit', r));
    child.kill('SIGKILL');
    await exited;
  }
  child = undefined;
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

function get(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function start(script: string): { out: () => string; exited: Promise<number | null>; up: () => Promise<number> } {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-startup-'));
  let output = '';
  child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `globalThis.fetch = async () => { throw new Error('offline test'); }; const { startServer } = await import('./src/server.ts'); ${script}`], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, SHELL: '/bin/sh', DISPATCH_TELEMETRY: '0', DISPATCH_BIND: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => { output += d; });
  child.stderr!.on('data', (d) => { output += d; });
  const exited = new Promise<number | null>((r) => child!.once('exit', r));
  const up = () => new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(() => { clearInterval(poll); reject(new Error(output)); }, 20000);
    const poll = setInterval(() => {
      const m = output.match(/listening on port (\d+)/);
      if (m) { clearInterval(poll); clearTimeout(deadline); resolve(Number(m[1])); }
    }, 25);
  });
  return { out: () => output, exited, up };
}

test('startServer on a random port answers /api/sessions and stops cleanly', async () => {
  // Port 0: the system picks the port, and startServer reports the real one.
  const d = start(`const s = await startServer({ port: 0 }); console.log('RETURNED_PORT=' + s.port);`);
  const port = await d.up();
  expect(port).toBeGreaterThan(0);
  await expect.poll(() => d.out(), { timeout: 5000 }).toMatch(/RETURNED_PORT=\d+/);
  expect(Number(d.out().match(/RETURNED_PORT=(\d+)/)![1])).toBe(port);
  const sessions = await get(port, '/api/sessions');
  expect(sessions.status).toBe(200);
  expect(JSON.parse(sessions.body)).toEqual([]);
  // The production order of the middleware: security headers, then the gate, then the routes.
  expect(sessions.headers['x-content-type-options']).toBe('nosniff');
  const remote = await get(port, '/api/sessions', { Host: '192.168.1.5:3456' });
  expect(remote.status).toBe(401);
  // The wires that only the daemon had before W3-A.
  expect((await get(port, '/api/terminals/stalls')).status).toBe(200);
  expect((await get(port, '/api/outbox')).status).toBe(200);
  expect((await get(port, '/api/bootstrap')).status).toBe(200);
  expect((await get(port, '/api/usage-limits/summary')).status).toBe(200);
  // The data dir holds what "dispatch status" reads.
  const listen = JSON.parse(fs.readFileSync(path.join(home, '.dispatch', 'listen.json'), 'utf8'));
  expect(listen).toMatchObject({ port, bind: '127.0.0.1', pid: child!.pid });
  expect(fs.existsSync(path.join(home, '.dispatch', 'dispatch.db'))).toBe(true);

  child!.kill('SIGTERM');
  const code = await Promise.race([d.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 8000))]);
  expect(code, d.out()).toBe(0);
  expect(d.out()).toMatch(/Shutting down Dispatch server/);
  expect(d.out()).not.toMatch(/Error|database connection is not open/);
}, 40000);

test('the cleanup function that startServer returns stops the daemon, and a second call is a no-op', async () => {
  const d = start(`const s = await startServer({ port: 0 }); console.log('READY'); setTimeout(() => { s.cleanup(); s.cleanup(); console.log('CLEANED'); }, 300);`);
  await d.up();
  const code = await Promise.race([d.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10000))]);
  expect(code, d.out()).toBe(0);
  expect(d.out()).toMatch(/CLEANED/);
  expect(d.out().match(/Shutting down Dispatch server/g)).toHaveLength(1);
}, 40000);
