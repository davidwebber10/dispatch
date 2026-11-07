import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CodexLoginService, parseDeviceAuth } from './codex-login.js';

/** The output of `codex login --device-auth` (codex-cli 0.167.0, under a PTY), code replaced. */
const DEVICE_OUTPUT = '\r\nWelcome to Codex [v\u001b[90m0.167.0\u001b[0m]\r\n\u001b[90mOpenAI\'s command-line coding agent\u001b[0m\r\n\r\n'
  + 'Follow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n'
  + '1. Open this link in your browser and sign in to your account\r\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\r\n\r\n'
  + '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\r\n   \u001b[94mABCD-12345\u001b[0m\r\n\r\n'
  + '\u001b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\u001b[0m\r\n\r\n';

function fakePty() {
  const em = new EventEmitter();
  const calls: { command: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  let killed = false;
  const proc: any = {
    onData: (cb: (d: string) => void) => em.on('data', cb),
    onExit: (cb: (e: { exitCode: number }) => void) => em.on('exit', cb),
    write: () => {},
    kill: () => { killed = true; em.emit('exit', { exitCode: 1 }); },
  };
  return {
    spawn: (command: string, args: string[], opts: any) => { calls.push({ command, args, env: opts.env }); return proc; },
    emit: (d: string) => em.emit('data', d),
    exit: (exitCode: number) => em.emit('exit', { exitCode }),
    calls,
    get killed() { return killed; },
  };
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-login-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('parseDeviceAuth', () => {
  test('reads the link and the one-time code out of the device-auth output', () => {
    expect(parseDeviceAuth(DEVICE_OUTPUT)).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' });
  });
  test('null until both have arrived', () => {
    expect(parseDeviceAuth(DEVICE_OUTPUT.slice(0, DEVICE_OUTPUT.indexOf('2. Enter')))).toBeNull();
  });
});

describe('CodexLoginService', () => {
  const make = (pty: ReturnType<typeof fakePty>) => new CodexLoginService({
    spawnPty: pty.spawn as any,
    env: () => ({ PATH: '/x/bin' }),
    isSignedIn: (home) => fs.existsSync(path.join(home, 'auth.json')),
    startTimeoutMs: 2000,
  });

  test('runs `codex login --device-auth` under the account\'s CODEX_HOME and returns the link and code', async () => {
    const pty = fakePty();
    const svc = make(pty);
    const p = svc.start('acc1', dir);
    pty.emit(DEVICE_OUTPUT);
    const s = await p;
    expect(pty.calls[0]).toMatchObject({ command: 'codex', args: ['login', '--device-auth'] });
    expect(pty.calls[0].env).toMatchObject({ CODEX_HOME: dir, PATH: '/x/bin' });
    expect(s).toMatchObject({ accountId: 'acc1', status: 'awaiting_user', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345', error: null });
    expect(svc.status('acc1')?.status).toBe('awaiting_user');
  });

  test('a second start while one waits returns the same attempt (a refresh or double tap keeps the code)', async () => {
    const pty = fakePty();
    const svc = make(pty);
    const p = svc.start('acc1', dir);
    pty.emit(DEVICE_OUTPUT);
    await p;
    const again = await svc.start('acc1', dir);
    expect(again.code).toBe('ABCD-12345');
    expect(pty.calls).toHaveLength(1);
  });

  test('complete once the CLI exits with a login file in the folder', async () => {
    const pty = fakePty();
    const svc = make(pty);
    const p = svc.start('acc1', dir);
    pty.emit(DEVICE_OUTPUT);
    await p;
    fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
    pty.exit(0);
    expect(svc.status('acc1')).toMatchObject({ status: 'complete', error: null });
  });

  test('an error with the CLI\'s own last line when it exits without a login, and a new start runs again', async () => {
    const pty = fakePty();
    const svc = make(pty);
    const p = svc.start('acc1', dir);
    pty.emit(DEVICE_OUTPUT);
    await p;
    pty.emit('Error logging in with device code: device code expired\r\n');
    pty.exit(1);
    expect(svc.status('acc1')).toMatchObject({ status: 'error', error: expect.stringMatching(/device code expired/) });
    const p2 = svc.start('acc1', dir);
    pty.emit(DEVICE_OUTPUT);
    expect((await p2).status).toBe('awaiting_user');
    expect(pty.calls).toHaveLength(2);
  });

  test('an error when the CLI exits before it prints a code', async () => {
    const pty = fakePty();
    const svc = make(pty);
    const p = svc.start('acc1', dir);
    pty.emit('Error: enable device code authorization for Codex in ChatGPT Security Settings\r\n');
    pty.exit(1);
    const s = await p;
    expect(s).toMatchObject({ status: 'error', error: expect.stringMatching(/device code authorization/) });
  });

  test('cancel kills the CLI and forgets the attempt', async () => {
    const pty = fakePty();
    const svc = make(pty);
    const p = svc.start('acc1', dir);
    pty.emit(DEVICE_OUTPUT);
    await p;
    svc.cancel('acc1');
    expect(pty.killed).toBe(true);
    expect(svc.status('acc1')).toBeNull();
  });
});
