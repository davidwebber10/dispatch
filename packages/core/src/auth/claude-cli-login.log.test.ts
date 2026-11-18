// The hosted box log of the Claude sign-in (os/box-log.ts): one JSON line per step, and never a code,
// a token, an e-mail or a URL query, even when the CLI's own error text carries one.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { ClaudeCliLogin, MSG, normalizeCode } from './claude-cli-login.js';
import { boxLog, redactLogText, setBoxLogForTest } from '../os/box-log.js';

const FAKE_CODE = 'Zq7xP3mK9vR2wT5yB8nC4dF6gH1jL0aS';
const FAKE_STATE = 'st4te9Xk2Lm8Qp3Rv7Ww1Yy5Zz0Aa6Bb';
const FAKE_TOKEN = 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const PRINTED = `If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=${FAKE_STATE}&login_hint=p%40example.com\n`;

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  stdin: Writable;
  constructor(onLine: (line: string, c: FakeChild) => void) {
    super();
    this.stdin = new Writable({ write: (chunk, _e, cb) => { onLine(chunk.toString(), this); cb(); } });
  }
  exit(code: number) { setTimeout(() => this.emit('exit', code, null), 1); }
  kill() { this.killed = true; this.exit(143); return true; }
}

function harness(onLine: (line: string, c: FakeChild) => void, status = '{"loggedIn":true,"authMethod":"claude.ai","email":"p@example.com"}') {
  const lines: string[] = [];
  setBoxLogForTest({ enabled: true, sink: (l) => lines.push(l) });
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const c = new FakeChild(onLine);
    children.push(c);
    setTimeout(() => { c.stdout.write(PRINTED); c.stdout.write('Paste code here if prompted > '); }, 2);
    return c as any;
  });
  const exec = vi.fn(async () => ({ stdout: status, code: 0 }));
  const login = new ClaudeCliLogin({ spawn, exec, env: () => ({ PATH: '/bin' }), startTimeoutMs: 1000, exchangeTimeoutMs: 1000 });
  const events = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { login, lines, events, children };
}

const noSecrets = (lines: string[]) => {
  const all = lines.join('\n');
  expect(all).not.toContain(FAKE_CODE);
  expect(all).not.toContain(FAKE_STATE);
  expect(all).not.toContain(FAKE_TOKEN);
  expect(all).not.toContain('p@example.com');
  expect(all).not.toContain('p%40example.com');
  expect(all).not.toContain('client_id=abc');
};

afterEach(() => setBoxLogForTest());

describe('the sign-in log (hosted)', () => {
  test('a good sign-in: start, URL issued (host only), code submitted (length and shape), exit 0, status, complete', async () => {
    const { login, lines, events } = harness((_l, c) => c.exit(0));
    await login.start({ email: 'p@example.com', tag: { kind: 'primary' } });
    const s = await login.submitCode(`  ${FAKE_CODE}#${FAKE_STATE}\n`);
    expect(s.status).toBe('complete');
    const e = events();
    expect(e.map((x) => x.event)).toEqual([
      'claude.signin.start', 'claude.signin.url_issued', 'claude.signin.code_submitted',
      'claude.signin.cli_exit', 'claude.signin.status', 'claude.signin.complete',
    ]);
    expect(e[0]).toMatchObject({ account: 'primary', reused: false, withEmail: true, src: 'dispatch', level: 'info' });
    expect(e[1]).toMatchObject({ host: 'claude.com' });
    expect(e[2]).toMatchObject({ length: FAKE_CODE.length + 1 + FAKE_STATE.length, shape: 'code#state', hadWhitespace: true });
    expect(e[3]).toMatchObject({ exitCode: 0 });
    expect(e[4]).toMatchObject({ loggedIn: true, authMethod: 'claude.ai' });
    for (const l of lines) expect(l.includes('\n')).toBe(false);
    noSecrets(lines);
  });

  test('a failed exchange logs the exit code and the CLI error, with the code and token removed', async () => {
    const { login, lines, events } = harness((_l, c) => {
      c.stderr.write(`Login failed: request to https://platform.claude.com/v1/oauth/token?code=${FAKE_CODE}&state=${FAKE_STATE} failed, Bearer ${FAKE_TOKEN}, code=${FAKE_CODE}\n`);
      c.exit(1);
    });
    await login.start({});
    const s = await login.submitCode(`${FAKE_CODE}#${FAKE_STATE}`);
    expect(s.status).toBe('error');
    const failed = events().find((x) => x.event === 'claude.signin.failed')!;
    expect(failed).toMatchObject({ level: 'error', exitCode: 1, reason: 'failedWith' });
    expect(String(failed.cliError)).toContain('Login failed');
    expect(String(failed.cliError)).toContain('https://platform.claude.com/v1/oauth/token?[redacted]');
    noSecrets(lines);
    // The person reads Claude's reason in plain words, also with nothing secret in it.
    expect(s.error!.startsWith(MSG.failedWith)).toBe(true);
    expect(s.error).not.toContain(FAKE_CODE);
    expect(s.error).not.toContain(FAKE_TOKEN);
  });

  test('a code with no #state is refused in plain words; the log has only its length and shape', async () => {
    const { login, lines, events, children } = harness(() => {});
    await login.start({});
    const s = await login.submitCode(FAKE_CODE);
    expect(s.status).toBe('awaiting_code');
    expect(s.error).toBe(MSG.noHash);
    expect(events().find((x) => x.event === 'claude.signin.code_submitted')).toMatchObject({ length: FAKE_CODE.length, shape: 'no-hash' });
    expect(children[0].killed).toBe(false);
    noSecrets(lines);
    login.cancel();
  });

  test('a local install writes no line', async () => {
    const lines: string[] = [];
    setBoxLogForTest({ enabled: false, sink: (l) => lines.push(l) });
    boxLog('daemon.start', { version: '1' });
    expect(lines).toEqual([]);
  });
});

describe('sign-in edge cases', () => {
  test('pasted text: spaces and line breaks go; "#" at an end or twice is not the code#state shape', () => {
    expect(normalizeCode(' a b#c\nd \r\n')).toMatchObject({ code: 'ab#cd', shape: 'code#state', hadWhitespace: true });
    expect(normalizeCode('abc')).toMatchObject({ shape: 'no-hash' });
    expect(normalizeCode('#abc').shape).toBe('bad-hash');
    expect(normalizeCode('abc#').shape).toBe('bad-hash');
    expect(normalizeCode('a#b#c').shape).toBe('bad-hash');
    expect(normalizeCode('  \n').shape).toBe('empty');
  });

  test('a new start while the first still waits for its link ends the first at once, not after its deadline', async () => {
    const children: FakeChild[] = [];
    let n = 0;
    const login = new ClaudeCliLogin({
      spawn: (() => {
        const c = new FakeChild(() => {});
        children.push(c);
        if (n++ > 0) setTimeout(() => c.stdout.write(PRINTED), 5); // the first never prints
        return c as any;
      }) as any,
      exec: async () => ({ stdout: '', code: 1 }), startTimeoutMs: 10_000,
    });
    const t0 = Date.now();
    const first = login.start({});
    await new Promise((r) => setTimeout(r, 20));
    const second = await login.start({});
    const a = await first;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(a.status).toBe('error');
    expect(second.status).toBe('awaiting_code');
    expect(children[0].killed).toBe(true);
    login.cancel();
  });

  test('a restarted daemon has no sign-in in progress, and a code then says to start again', async () => {
    const login = new ClaudeCliLogin({ spawn: (() => new FakeChild(() => {})) as any, exec: async () => ({ stdout: '', code: 1 }) });
    expect(login.status()).toBeNull();
    await expect(login.submitCode('a#b')).rejects.toMatchObject({ code: 'no_session' });
  });

  test('the not-signed-in message has no machine words', () => {
    for (const m of Object.values(MSG)) expect(m).not.toMatch(/\bbox\b|container|daemon|server/i);
  });
});

describe('redactLogText', () => {
  test('removes codes, tokens, queries and e-mail addresses, and keeps the words', () => {
    const out = redactLogText(`failed for p@example.com: ${FAKE_CODE}#${FAKE_STATE} token=${FAKE_TOKEN} at https://x.example/cb?code=${FAKE_CODE} (${FAKE_TOKEN}) ${FAKE_CODE}`);
    expect(out).not.toContain(FAKE_CODE);
    expect(out).not.toContain(FAKE_STATE);
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).not.toContain('p@example.com');
    expect(out).toContain('failed for');
    expect(out).toContain('https://x.example/cb?[redacted]');
  });
  test('cuts a long text', () => {
    expect(redactLogText('word '.repeat(200)).length).toBeLessThanOrEqual(301);
  });
});
