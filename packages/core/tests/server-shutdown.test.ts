import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

test('SIGTERM exits with a browser events WebSocket still connected', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-shutdown-'));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `globalThis.fetch = async () => { throw new Error('offline test'); }; const { startServer } = await import('./src/server.ts'); await startServer({port:${port}});`], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, SHELL: '/bin/sh' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let socket: WebSocket | undefined;
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  try {
    const actual = await new Promise<number>((resolve, reject) => {
      const deadline = setTimeout(() => { clearInterval(poll); reject(new Error(output)); }, 10000);
      const poll = setInterval(() => {
        const match = output.match(/listening on port (\d+)/);
        if (match) { clearInterval(poll); clearTimeout(deadline); resolve(Number(match[1])); }
      }, 25);
    });
    socket = new WebSocket(`ws://127.0.0.1:${actual}/api/events`);
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });
    child.kill('SIGTERM');
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([exited, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Shutdown hung with a connected browser:\n' + output)), 5000);
      })]);
      expect(code).toBe(0);
    } finally { clearTimeout(deadline); }
  } finally {
    socket?.terminate();
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
