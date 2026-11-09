import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ClaudeLoginService, extractCliError, extractUrl, extractToken, lastMeaningfulLine, stripAnsi } from './claude-login.js';

/** Minimal node-pty stand-in: lets a test script the CLI's output. */
function fakePty() {
  const em = new EventEmitter();
  const written: string[] = [];
  let killed = false;
  const proc: any = {
    onData: (cb: (d: string) => void) => em.on('data', cb),
    onExit: (cb: () => void) => em.on('exit', cb),
    write: (d: string) => { written.push(d); },
    kill: () => { killed = true; em.emit('exit'); },
  };
  return {
    spawn: () => proc,
    emit: (d: string) => em.emit('data', d),
    exit: () => em.emit('exit'),
    written,
    get killed() { return killed; },
  };
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-login-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('output parsing', () => {
  test('recovers the FULL url from the OSC-8 parameter when the visible text is truncated', () => {
    // Observed shape from a real `claude setup-token`: the complete URL is the
    // hyperlink's parameter, and the visible link text is wrapped/truncated to the
    // terminal width. Taking the first or the stripped match yields a broken URL
    // that fails silently when the user opens it.
    const full = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abcdefghijklmnop';
    const truncated = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&sta';
    const raw = `\x1b]8;id=1;${full}\x07${truncated}\x1b]8;;\x07`;
    expect(extractUrl(raw)).toBe(full);
  });

  test('extracts the minted token', () => {
    expect(extractToken('Success!\r\n  sk-ant-oat01-AbC_123-xyz\r\n')).toBe('sk-ant-oat01-AbC_123-xyz');
  });

  test('returns null when neither is present', () => {
    expect(extractUrl('nothing here')).toBeNull();
    expect(extractToken('nothing here')).toBeNull();
  });

  test('stripAnsi removes CSI and OSC sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });
});

describe('ClaudeLoginService', () => {
  test('unauthenticated by default; token drives spawn env', async () => {
    const svc = new ClaudeLoginService(dir, (() => fakePty().spawn()) as any);
    expect(svc.isAuthenticated()).toBe(false);
    expect(svc.getSpawnEnv()).toEqual({});
  });

  test('start() resolves with the URL once the CLI prints it', async () => {
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    const p = svc.start();
    setTimeout(() => f.emit('Browser didn\'t open? https://claude.com/cai/oauth/authorize?code=true&x=1\r\n'), 20);
    const s = await p;
    expect(s.status).toBe('awaiting_code');
    expect(s.url).toContain('https://claude.com/cai/oauth/authorize');
  });

  test('submitCode() writes the code, captures the token, and persists it 0600', async () => {
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    const p = svc.start();
    setTimeout(() => f.emit('https://claude.com/cai/oauth/authorize?x=1\r\n'), 20);
    await p;

    const done = svc.submitCode('  my-code  ');
    setTimeout(() => f.emit('\r\nsk-ant-oat01-TOKENVALUE_123\r\n'), 20);
    const s = await done;

    expect(s.status).toBe('complete');
    expect(f.written).toEqual(['my-code', '\r']);       // trimmed; Enter sent separately
    expect(svc.getToken()).toBe('sk-ant-oat01-TOKENVALUE_123');
    expect(svc.getSpawnEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-TOKENVALUE_123' });
    expect(fs.statSync(path.join(dir, 'claude-oauth-token')).mode & 0o777).toBe(0o600);
    expect(f.killed).toBe(true);                        // temp PTY cleaned up
  });

  test('a token echoed BEFORE the code is submitted is not mistaken for the result', async () => {
    // The pasted code is echoed back by the PTY. Scanning the whole buffer would let
    // pre-existing output satisfy the token regex and "succeed" without an exchange.
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    const p = svc.start();
    setTimeout(() => f.emit('https://claude.com/cai/oauth/authorize?x=1 sk-ant-oat01-STALE\r\n'), 20);
    await p;
    const done = svc.submitCode('code');
    setTimeout(() => f.emit('\r\nsk-ant-oat01-FRESH\r\n'), 20);
    expect((await done).status).toBe('complete');
    expect(svc.getToken()).toBe('sk-ant-oat01-FRESH');
  });

  test('submitCode() rejects when no login is in progress', async () => {
    const svc = new ClaudeLoginService(dir, (() => fakePty().spawn()) as any);
    await expect(svc.submitCode('x')).rejects.toThrow(/no login in progress/);
  });

  test('an early CLI exit surfaces as an error rather than hanging', async () => {
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    const p = svc.start();
    setTimeout(() => f.exit(), 20);
    const s = await p;
    expect(s.status).toBe('error');
    expect(s.error).toMatch(/exited before completing/);
  });

  test('signOut() forgets the token', async () => {
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    const p = svc.start();
    setTimeout(() => f.emit('https://claude.com/cai/oauth/x\r\n'), 20);
    await p;
    const done = svc.submitCode('c');
    setTimeout(() => f.emit('sk-ant-oat01-AAA\r\n'), 20);
    await done;
    expect(svc.isAuthenticated()).toBe(true);
    svc.signOut();
    expect(svc.isAuthenticated()).toBe(false);
    expect(svc.getSpawnEnv()).toEqual({});
  });
});

describe('start() idempotency — the flow requires leaving the page', () => {
  test('a second start() returns the SAME pending session rather than killing it', async () => {
    // The user opens the URL, authorises, copies a code, comes back. A double-click,
    // a remount or a refresh in that window used to destroy the in-flight login and
    // leave them submitting a code against a session that no longer existed.
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    const p = svc.start();
    setTimeout(() => f.emit('https://claude.com/cai/oauth/authorize?x=1\r\n'), 20);
    const first = await p;

    const second = await svc.start();
    expect(second.id).toBe(first.id);
    expect(second.url).toBe(first.url);
    expect(f.killed).toBe(false);   // the in-flight attempt survived
  });

  test('submitCode without a session reports a machine-readable code', async () => {
    // So the UI can offer "start again" instead of surfacing a raw 400.
    const svc = new ClaudeLoginService(dir, (() => fakePty().spawn()) as any);
    await expect(svc.submitCode('x')).rejects.toMatchObject({ code: 'no_session' });
  });
})

describe('token extraction survives the terminal', () => {
  test('recovers a token that the PTY hard-wrapped mid-string', () => {
    // The exact failure seen in os-prod: a 120-column PTY wraps a ~100-char token,
    // so the pattern matched only the fragment before the break and the exchange
    // "timed out" while the token was sitting right there.
    const token = 'sk-ant-oat01-' + 'A1b2C3d4E5f6G7h8'.repeat(6)
    const wrapped = token.slice(0, 60) + '\r\n' + token.slice(60)
    expect(extractToken(`Success!\r\n${wrapped}\r\n`)).toBe(token)
  })

  test('still finds an unwrapped token', () => {
    const token = 'sk-ant-oat01-' + 'Zz9'.repeat(30)
    expect(extractToken(`\r\n${token}\r\n`)).toBe(token)
  })

  test('lastMeaningfulLine surfaces what the CLI actually said', () => {
    // So a bad or already-used code reports the reason instead of "timed out".
    const out = 'Paste code here\r\n\r\n────────\r\nInvalid authorization code.\r\n'
    expect(lastMeaningfulLine(out)).toBe('Invalid authorization code.')
  })
})

describe('a rejected code is recoverable, not terminal', () => {
  test('extractCliError picks up the CLI rejection', () => {
    // Captured verbatim from a real setup-token run against a bad code.
    const out = 'Paste code here if prompted >\r\nOAuth error: Invalid code. Please make sure the full code was copied\r\rPress Enter to retry.'
    expect(extractCliError(out)).toMatch(/Invalid code/)
  })

  test('submitCode reports the rejection immediately and keeps the attempt alive', async () => {
    // Waiting out the 45s timeout turned an instant, actionable message into a
    // useless "timed out", and killing the session forced a full restart.
    const f = fakePty()
    const svc = new ClaudeLoginService(dir, f.spawn as any)
    const p = svc.start()
    setTimeout(() => f.emit('https://claude.com/cai/oauth/authorize?x=1\r\n'), 20)
    await p

    const done = svc.submitCode('too-short')
    setTimeout(() => f.emit('\r\nOAuth error: Invalid code. Please make sure the full code was copied\r\n'), 20)
    const s = await done

    expect(s.status).toBe('awaiting_code')      // still usable
    expect(s.error).toMatch(/Invalid code/)
    expect(f.killed).toBe(false)
    expect(svc.isAuthenticated()).toBe(false)
  })

  test('the masked echo of the pasted code is not mistaken for an error', () => {
    // The CLI masks the code as asterisks; that row is never the reason for failure.
    expect(lastMeaningfulLine('****************************\r\nOAuth error: nope')).toBe('OAuth error: nope')
  })
})

describe('submission is a paste THEN a keypress', () => {
  test('the code and the Enter are written separately', async () => {
    // Claude Code's Ink TUI does bracketed-paste detection: a '\r' arriving in the
    // same burst as a long code is absorbed as literal content, so the field fills
    // and never submits — the CLI then prints neither error nor token and the
    // exchange times out. Verified against the real CLI in os-prod: combined write
    // produced no response; separate writes produced an immediate answer.
    const f = fakePty()
    const svc = new ClaudeLoginService(dir, f.spawn as any)
    const p = svc.start()
    setTimeout(() => f.emit('https://claude.com/cai/oauth/x\r\n'), 20)
    await p

    const long = 'g'.repeat(60) + '#' + 's'.repeat(40)
    const done = svc.submitCode(long)
    setTimeout(() => f.emit('\r\nsk-ant-oat01-TOKENAAA\r\n'), 400)
    await done

    expect(f.written).toEqual([long, '\r'])   // two writes, never one
  })
})

describe('one link: the code link', () => {
  /** A fake PTY whose spawn call records its options. */
  function recording() {
    const f = fakePty();
    const calls: any[] = [];
    return { f, calls, spawn: ((cmd: string, args: string[], opts: any) => { calls.push({ cmd, args, opts }); return f.spawn(); }) as any };
  }
  const URL_LINE = 'https://claude.com/cai/oauth/authorize?code=true&x=1\r\n';
  const ready = async (svc: ClaudeLoginService, f: ReturnType<typeof fakePty>, begin: () => Promise<unknown> = () => svc.start()) => {
    const p = begin();
    setTimeout(() => f.emit(URL_LINE), 20);
    await p;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('the CLI cannot open its own browser tab: that tab gives no code', async () => {
    // Observed on claude 2.1.319: setup-token opens a tab with a localhost redirect by itself,
    // and only the printed link shows a code. A user who approved the tab got no code.
    const r = recording();
    const svc = new ClaudeLoginService(dir, r.spawn);
    await ready(svc, r.f);
    expect(r.calls[0].args).toEqual(['setup-token']);
    expect(r.calls[0].opts.env.BROWSER).toBe('true');
    expect(r.calls[0].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
  });

  test('a token the CLI prints with no code submitted is saved', async () => {
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    await ready(svc, f);
    f.emit('\r\nsk-ant-oat01-NOCODE_TOKEN\r\n');
    await sleep(700);
    expect(svc.getToken()).toBe('sk-ant-oat01-NOCODE_TOKEN');
    expect(svc.status()?.status).toBe('complete');
    expect(f.killed).toBe(true);
  });

  test('that token becomes the new account for an account login', async () => {
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    const got: Array<[string, string]> = [];
    svc.onAccountToken = (token, label) => { got.push([token, label]); };
    await ready(svc, f, () => svc.startForAccount('Work'));
    f.emit('\r\nsk-ant-oat01-ACCOUNT_TOKEN\r\n');
    await sleep(700);
    expect(got).toEqual([['sk-ant-oat01-ACCOUNT_TOKEN', 'Work']]);
    expect(svc.getToken()).toBeNull();
  });

  test('a token cut in two by the terminal waits for the rest, however long', async () => {
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    await ready(svc, f);
    f.emit('\r\nsk-ant-oat01-FIRSTHALF');
    await sleep(700); // longer than two watches
    expect(svc.getToken()).toBeNull();
    f.emit('_SECONDHALF\r\n');
    await sleep(400);
    expect(svc.getToken()).toBe('sk-ant-oat01-FIRSTHALF_SECONDHALF');
  });

  test('a CLI that prints the token and exits at once still saves it', async () => {
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    await ready(svc, f);
    f.emit('\r\nsk-ant-oat01-THEN_EXIT\r\n');
    f.exit();
    expect(svc.getToken()).toBe('sk-ant-oat01-THEN_EXIT');
    expect(svc.status()?.status).toBe('complete');
  });

  test('a CLI that exits right after a submitted code still saves the token, once', async () => {
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    let saved = 0;
    svc.onAccountToken = () => { saved++; };
    await ready(svc, f, () => svc.startForAccount('Work'));
    const done = svc.submitCode('code');
    f.emit('\r\nsk-ant-oat01-SUBMIT_EXIT\r\n');
    f.exit();
    expect((await done).status).toBe('complete');
    expect(saved).toBe(1);
  });

  /** Spawns a new fake PTY for each attempt. */
  const sequence = () => {
    const fakes: Array<ReturnType<typeof fakePty>> = [];
    return { fakes, spawn: (() => { const f = fakePty(); fakes.push(f); return f.spawn(); }) as any };
  };
  const readyOn = async (seq: ReturnType<typeof sequence>, begin: () => Promise<unknown>) => {
    const p = begin();
    setTimeout(() => seq.fakes[seq.fakes.length - 1].emit(URL_LINE), 20);
    await p;
  };

  test('status() still reports the finished login, and a real new start clears it', async () => {
    const seq = sequence();
    const svc = new ClaudeLoginService(dir, seq.spawn);
    await readyOn(seq, () => svc.start());
    const first = svc.status()!.id;
    const done = svc.submitCode('c');
    setTimeout(() => seq.fakes[0].emit('sk-ant-oat01-DONE\r\n'), 20);
    await done;
    expect(svc.status()).toMatchObject({ id: first, status: 'complete', error: null });
    await readyOn(seq, () => svc.start());
    expect(svc.status()!.id).not.toBe(first);
    expect(svc.status()!.status).toBe('awaiting_code');
    svc.cancel();
    expect(svc.status()).toBeNull();
  });

  test('a code submitted after the CLI printed a token keeps that token', async () => {
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    await ready(svc, f);
    f.emit('\r\nsk-ant-oat01-PRINTED_FIRST\r\n');
    const s = await svc.submitCode('late-code');
    expect(s.status).toBe('complete');
    expect(svc.getToken()).toBe('sk-ant-oat01-PRINTED_FIRST');
    expect(f.written).toEqual([]);
  });

  test('a second start with the same destination returns the waiting login', async () => {
    const seq = sequence();
    const svc = new ClaudeLoginService(dir, seq.spawn);
    await readyOn(seq, () => svc.startForAccount('Work'));
    const first = svc.status()!.id;
    const again = await svc.startForAccount(' Work ');
    expect(again.id).toBe(first);
    expect(seq.fakes).toHaveLength(1);
  });

  test('a start for another destination replaces the waiting login, so its token cannot change owner', async () => {
    const seq = sequence();
    const svc = new ClaudeLoginService(dir, seq.spawn);
    const got: string[] = [];
    svc.onAccountToken = (_token, label) => { got.push(label); };
    await readyOn(seq, () => svc.startForAccount('Work'));
    const first = svc.status()!.id;
    await readyOn(seq, () => svc.start());
    expect(seq.fakes[0].killed).toBe(true);
    expect(svc.status()!.id).not.toBe(first);
    seq.fakes[1].emit('\r\nsk-ant-oat01-SINGLE\r\n');
    await sleep(700);
    expect(got).toEqual([]);
    expect(svc.getToken()).toBe('sk-ant-oat01-SINGLE');
  });

  test('the login is complete only after the account is stored, even if the CLI exits first', async () => {
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    let stored = () => {};
    let calls = 0;
    svc.onAccountToken = () => { calls++; return new Promise<void>((r) => { stored = r; }); };
    await ready(svc, f, () => svc.startForAccount('Work'));
    f.emit('\r\nsk-ant-oat01-SLOW_STORE\r\n');
    await sleep(700);
    expect(svc.status()?.status).toBe('exchanging');
    f.exit();
    await sleep(50);
    expect(svc.status()?.status).toBe('exchanging');
    stored();
    await sleep(20);
    expect(svc.status()?.status).toBe('complete');
    expect(calls).toBe(1);
  });

  test('an account that cannot be stored ends the login and is not tried again', async () => {
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    let calls = 0;
    svc.onAccountToken = () => { calls++; return Promise.reject(new Error('disk full')); };
    await ready(svc, f, () => svc.startForAccount('Work'));
    const done = svc.submitCode('c');
    setTimeout(() => f.emit('\r\nsk-ant-oat01-NOSTORE\r\n'), 20);
    const s = await done;
    expect(s.status).toBe('error');
    expect(s.error).toMatch(/could not save/i);
    expect(calls).toBe(1);
    expect(f.killed).toBe(true);
  });

  test('a saved login that cannot be written ends the attempt from the watch', async () => {
    const f = fakePty();
    const notADir = path.join(dir, 'file');
    fs.writeFileSync(notADir, 'x');
    const svc = new ClaudeLoginService(notADir, f.spawn as any);
    await ready(svc, f);
    f.emit('\r\nsk-ant-oat01-NOWRITE\r\n');
    await sleep(700);
    expect(f.killed).toBe(true);
    expect(svc.status()).toBeNull();
  });

  test('a code that arrives during the save waits for the save and reports it', async () => {
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    let stored = () => {};
    svc.onAccountToken = () => new Promise<void>((r) => { stored = r; });
    await ready(svc, f, () => svc.startForAccount('Work'));
    f.emit('\r\nsk-ant-oat01-SAVING\r\n');
    await sleep(400);
    const done = svc.submitCode('late');
    await sleep(20);
    stored();
    expect((await done).status).toBe('complete');
    expect(f.written).toEqual([]);
  });

  test('a code submitted between the two halves of a token does not save the first half', async () => {
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    await ready(svc, f);
    f.emit('\r\nsk-ant-oat01-FIRSTHALF');
    const done = svc.submitCode('c');
    await sleep(300);
    expect(svc.getToken()).toBeNull();
    expect(f.written).toEqual(['c', '\r']);
    f.emit('\r\nOAuth error: Invalid code\r\n');
    expect((await done).status).toBe('awaiting_code');
  });

  test('a start during a save waits for that save before it replaces the attempt', async () => {
    const seq = sequence();
    const svc = new ClaudeLoginService(dir, seq.spawn);
    let stored = () => {};
    svc.onAccountToken = () => new Promise<void>((r) => { stored = r; });
    await readyOn(seq, () => svc.startForAccount('Work'));
    seq.fakes[0].emit('\r\nsk-ant-oat01-OLD_SAVE\r\n');
    await sleep(400);
    const next = svc.startForAccount('Personal');
    await sleep(50);
    expect(seq.fakes).toHaveLength(1);
    stored();
    await sleep(20);
    expect(seq.fakes).toHaveLength(2);
    seq.fakes[1].emit(URL_LINE);
    expect((await next).status).toBe('awaiting_code');
  });

  test('a CLI that prints the link and exits at once is reported as failed', async () => {
    const f = fakePty();
    const svc = new ClaudeLoginService(dir, f.spawn as any);
    const p = svc.start();
    setTimeout(() => { f.emit(URL_LINE); f.exit(); }, 20);
    expect((await p).status).toBe('error');
  });
});
