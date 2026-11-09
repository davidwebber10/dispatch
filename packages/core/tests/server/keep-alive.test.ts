// W2-H: the daemon keeps an idle connection for 75 s (Node's default is 5 s). A page that talks to
// `http://…:3456` directly (Tailscale) then pays no new connection after each pause of more than 5 s.
import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

test('keepAliveTimeout is 75000', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-keepalive-'));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `globalThis.fetch = async () => { throw new Error('offline test'); }; const { startServer } = await import('./src/server.ts'); await startServer({port:${port}});`], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, SHELL: '/bin/sh', DISPATCH_TELEMETRY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const actual = await new Promise<number>((resolve, reject) => {
      const deadline = setTimeout(() => { clearInterval(poll); reject(new Error(output)); }, 20000);
      const poll = setInterval(() => {
        const match = output.match(/listening on port (\d+)/);
        if (match) { clearInterval(poll); clearTimeout(deadline); resolve(Number(match[1])); }
      }, 25);
    });
    const get = () => new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: actual, path: '/api/whoami', agent }, (res) => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
    });
    const first = await get();
    expect(first.statusCode).toBe(200);
    // Node tells the client its keepAliveTimeout in whole seconds; headersTimeout must be above it.
    expect(first.headers['keep-alive']).toBe('timeout=75');
    expect(first.headers.connection).toBe('keep-alive');
    // After a pause longer than Node's default 5 s, the same connection still serves a request.
    const socket = first.socket;
    await new Promise((r) => setTimeout(r, 6000));
    const second = await get();
    expect(second.statusCode).toBe(200);
    expect(second.socket).toBe(socket);
  } finally {
    agent.destroy();
    child.kill('SIGTERM');
    const t = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000);
    await exited;
    clearTimeout(t);
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 40000);
