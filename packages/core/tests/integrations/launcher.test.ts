import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { spawn, type SpawnOptions } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { PassThrough } from 'stream';
import {
  encodeLaunchSpec, decodeLaunchSpec, launcherArgs, buildLaunch, runLauncher, redactor, pipeRedacted,
  integrationLogPath, openIntegrationLog, pruneIntegrationLogs,
  type LaunchSpec, type SecretSource,
} from '../../src/integrations/launcher.js';
import { SecretsService } from '../../src/secrets/service.js';

// Fake values only. Each test asserts none of them reach argv or the stderr line.
const DOPPLER_VALUE = 'fake-doppler-value-123';
const ENV_VALUE = 'fake-env-value-456';

/**
 * A nested temp sandbox per test: <mkdtemp>/secrets and <mkdtemp>/work. Only that mkdtemp,
 * checked to sit directly in the temp dir, is ever removed.
 */
function sandboxEach(): { root: string; secretsDir: string; workDir: string } {
  const sb = { root: '', secretsDir: '', workDir: '' };
  beforeEach(() => {
    sb.root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-launcher-'));
    sb.secretsDir = path.join(sb.root, 'secrets');
    sb.workDir = path.join(sb.root, 'work');
    fs.mkdirSync(sb.secretsDir);
    fs.mkdirSync(sb.workDir);
  });
  afterEach(() => {
    if (path.dirname(sb.root) === path.resolve(os.tmpdir()) && path.basename(sb.root).startsWith('dispatch-launcher-')) {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });
  return sb;
}

function doppler(opts: { connected?: boolean; enabled?: boolean; secrets?: Record<string, string>; throws?: boolean } = {}) {
  const getSecret = vi.fn(async (name: string) => {
    if (opts.throws) throw new Error('Doppler 404: not found');
    return opts.secrets?.[name] ?? null;
  });
  const source: SecretSource = {
    status: () => ({ connected: opts.connected ?? true, enabled: opts.enabled ?? true, project: 'acme', config: 'dev', readOnly: false }),
    getSecret,
  };
  return { source, getSecret };
}

/**
 * A spawn stand-in: records what would run, then exits the "child" with `code` — or, with
 * `fail`, throws `fail.throws` synchronously or emits `fail.error` the way a real spawn does.
 */
function fakeSpawn(code = 0, fail: { throws?: Error; error?: Error } = {}) {
  const calls: { command: string; args: string[]; env: Record<string, string | undefined>; stdio: unknown }[] = [];
  const children: (EventEmitter & { kill: ReturnType<typeof vi.fn> })[] = [];
  const spawn = vi.fn((command: string, args: string[], opts: { env: Record<string, string | undefined>; stdio: unknown }) => {
    if (fail.throws) throw fail.throws;
    calls.push({ command, args, env: opts.env, stdio: opts.stdio });
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    children.push(child);
    if (fail.error) setImmediate(() => child.emit('error', fail.error));
    else if (code >= 0) setImmediate(() => child.emit('exit', code, null));
    return child;
  });
  return { spawn, calls, children };
}

/** An error shaped like Node's, whose message quotes a value (as ERR_INVALID_ARG_VALUE's does). */
function errorQuoting(value: string, code: string): Error {
  return Object.assign(new Error(`The argument 'options.env['KEY']' ... Received '${value}'`), { code });
}

const argvFor = (spec: LaunchSpec) => launcherArgs('/x/launcher.js', '/x/secrets', spec).slice(1);

const REMOTE: LaunchSpec = {
  name: 'linear', type: 'remote', url: 'https://mcp.linear.app/sse',
  headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' }, env: { NODE_OPTIONS: '--no-warnings' },
};
const STDIO: LaunchSpec = {
  name: 'gh', type: 'stdio', command: 'npx', args: ['-y', 'gh-mcp', '${NOT_RESOLVED}'],
  env: { GITHUB_TOKEN: '${GH_PAT}', ROOT: '/tmp' },
};

describe('launch spec encoding', () => {
  it('round-trips through base64url, with no characters a CLI would expand', () => {
    const encoded = encodeLaunchSpec(REMOTE);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLaunchSpec(encoded)).toEqual(REMOTE);
  });

  it('launcherArgs is launcher path, --secrets-dir, --spec', () => {
    expect(launcherArgs('/x/launcher.js', '/x/secrets', STDIO)).toEqual(['/x/launcher.js', '--secrets-dir', '/x/secrets', '--spec', encodeLaunchSpec(STDIO)]);
  });

  it('rejects a spec that is not a stdio or remote integration', () => {
    expect(() => decodeLaunchSpec(Buffer.from('{"type":"other"}').toString('base64url'))).toThrow();
    expect(() => decodeLaunchSpec(Buffer.from('{"type":"stdio"}').toString('base64url'))).toThrow();
    expect(() => decodeLaunchSpec('not json')).toThrow();
  });
});

describe('buildLaunch (templates + resolved values → child)', () => {
  it('stdio: substitutes env values, keeps args literal, never puts a value in args', () => {
    const plan = buildLaunch(STDIO, { GH_PAT: DOPPLER_VALUE });
    expect(plan).toEqual({
      command: 'npx',
      args: ['-y', 'gh-mcp', '${NOT_RESOLVED}'],
      env: { GITHUB_TOKEN: DOPPLER_VALUE, ROOT: '/tmp' },
    });
    expect(JSON.stringify([plan.command, plan.args])).not.toContain(DOPPLER_VALUE);
  });

  it('remote: header templates stay literal in argv; each resolved NAME=value goes to the child env', () => {
    const plan = buildLaunch(REMOTE, { LINEAR_TOKEN: DOPPLER_VALUE });
    expect(plan.command).toBe('npx');
    expect(plan.args).toEqual(['-y', 'mcp-remote', 'https://mcp.linear.app/sse', '--header', 'Authorization:Bearer ${LINEAR_TOKEN}']);
    expect(plan.env).toEqual({ NODE_OPTIONS: '--no-warnings', LINEAR_TOKEN: DOPPLER_VALUE });
    expect(JSON.stringify(plan.args)).not.toContain(DOPPLER_VALUE);
  });

  it('remote: refs inside env values are substituted too', () => {
    const plan = buildLaunch({ ...REMOTE, env: { HTTPS_PROXY: 'http://u:${PROXY_PASS}@proxy' } }, { LINEAR_TOKEN: 'a', PROXY_PASS: 'b' });
    expect(plan.env).toEqual({ HTTPS_PROXY: 'http://u:b@proxy', LINEAR_TOKEN: 'a' });
  });
});

describe('runLauncher', () => {
  let stderr: string[];
  const write = (line: string) => { stderr.push(line); };
  beforeEach(() => { stderr = []; });

  it('resolves a ref from Doppler and spawns the child with the value only in its env', async () => {
    const { source, getSecret } = doppler({ secrets: { GH_PAT: DOPPLER_VALUE } });
    const fake = fakeSpawn(0);
    const res = await runLauncher(argvFor(STDIO), { secrets: () => source, env: { PATH: '/bin' }, stderr: write, spawn: fake.spawn as never });
    expect(res).toEqual({ code: 0, signal: null });
    expect(getSecret).toHaveBeenCalledWith('GH_PAT');
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.command).toBe('npx');
    expect(call.env).toMatchObject({ PATH: '/bin', GITHUB_TOKEN: DOPPLER_VALUE, ROOT: '/tmp' });
    expect(JSON.stringify([call.command, call.args])).not.toContain(DOPPLER_VALUE);
    expect(stderr).toEqual([]);
  });

  it('opens Doppler from the --secrets-dir it was given', async () => {
    const { source } = doppler({ secrets: { GH_PAT: DOPPLER_VALUE } });
    const factory = vi.fn(() => source);
    await runLauncher(argvFor(STDIO), { secrets: factory, env: {}, stderr: write, spawn: fakeSpawn(0).spawn as never });
    expect(factory).toHaveBeenCalledWith('/x/secrets');
  });

  it('falls back to its own env when Doppler lacks the secret', async () => {
    const { source, getSecret } = doppler({ secrets: {} });
    const fake = fakeSpawn(0);
    await runLauncher(argvFor(STDIO), { secrets: () => source, env: { GH_PAT: ENV_VALUE }, stderr: write, spawn: fake.spawn as never });
    expect(getSecret).toHaveBeenCalled();
    expect(fake.calls[0].env.GITHUB_TOKEN).toBe(ENV_VALUE);
  });

  it('falls back to its own env when the Doppler lookup fails', async () => {
    const { source } = doppler({ throws: true });
    const fake = fakeSpawn(0);
    await runLauncher(argvFor(STDIO), { secrets: () => source, env: { GH_PAT: ENV_VALUE }, stderr: write, spawn: fake.spawn as never });
    expect(fake.calls[0].env.GITHUB_TOKEN).toBe(ENV_VALUE);
    expect(stderr).toEqual([]);
  });

  it.each([
    ['not connected', { connected: false }],
    ['disabled', { enabled: false }],
  ])('does not ask Doppler when it is %s, and uses its own env', async (_label, opts) => {
    const { source, getSecret } = doppler({ ...opts, secrets: { GH_PAT: DOPPLER_VALUE } });
    const fake = fakeSpawn(0);
    await runLauncher(argvFor(STDIO), { secrets: () => source, env: { GH_PAT: ENV_VALUE }, stderr: write, spawn: fake.spawn as never });
    expect(getSecret).not.toHaveBeenCalled();
    expect(fake.calls[0].env.GITHUB_TOKEN).toBe(ENV_VALUE);
  });

  it('remote: resolves header refs into the child env and keeps the header template literal in argv', async () => {
    const { source } = doppler({ secrets: { LINEAR_TOKEN: DOPPLER_VALUE } });
    const fake = fakeSpawn(0);
    await runLauncher(argvFor(REMOTE), { secrets: () => source, env: {}, stderr: write, spawn: fake.spawn as never });
    const call = fake.calls[0];
    expect(call.args).toContain('Authorization:Bearer ${LINEAR_TOKEN}');
    expect(call.env.LINEAR_TOKEN).toBe(DOPPLER_VALUE);
    expect(JSON.stringify(call.args)).not.toContain(DOPPLER_VALUE);
  });

  it('a missing ref exits 1 with one stderr line naming it and the Doppler project/config, and no value', async () => {
    const spec: LaunchSpec = { name: 'gh', type: 'stdio', command: 'npx', env: { A: '${FOUND}', B: '${MISSING_ONE}' } };
    const { source } = doppler({ secrets: { FOUND: DOPPLER_VALUE } });
    const fake = fakeSpawn(0);
    const res = await runLauncher(argvFor(spec), { secrets: () => source, env: {}, stderr: write, spawn: fake.spawn as never });
    expect(res).toEqual({ code: 1, signal: null });
    expect(fake.spawn).not.toHaveBeenCalled();
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('${MISSING_ONE}');
    expect(stderr[0]).toContain('acme/dev');
    expect(stderr[0]).toContain('gh');
    expect(stderr[0]).not.toContain('\n');
    expect(stderr[0]).not.toContain(DOPPLER_VALUE);
  });

  it('a missing ref with Doppler not connected says so', async () => {
    const { source } = doppler({ connected: false });
    const res = await runLauncher(argvFor(STDIO), { secrets: () => source, env: {}, stderr: write, spawn: fakeSpawn(0).spawn as never });
    expect(res.code).toBe(1);
    expect(stderr[0]).toMatch(/\$\{GH_PAT\}.*Doppler \(acme\/dev\) is not connected/);
  });

  it('bad argv exits 1 with a usage line', async () => {
    const res = await runLauncher(['--spec'], { secrets: () => doppler().source, env: {}, stderr: write, spawn: fakeSpawn(0).spawn as never });
    expect(res.code).toBe(1);
    expect(stderr[0]).toMatch(/--secrets-dir/);
  });

  it('forwards SIGINT/SIGTERM/SIGHUP to the child and reports its signal', async () => {
    const { source } = doppler({ secrets: { GH_PAT: DOPPLER_VALUE } });
    const fake = fakeSpawn(-1); // never exits on its own
    const before = new Set(process.listeners('SIGTERM'));
    const done = runLauncher(argvFor(STDIO), { secrets: () => source, env: {}, stderr: write, spawn: fake.spawn as never });
    await vi.waitFor(() => expect(fake.children).toHaveLength(1));
    const forward = process.listeners('SIGTERM').find((l) => !before.has(l))!;
    expect(forward).toBeTypeOf('function');
    (forward as (s: NodeJS.Signals) => void)('SIGTERM');
    expect(fake.children[0].kill).toHaveBeenCalledWith('SIGTERM');
    fake.children[0].emit('exit', null, 'SIGTERM');
    expect(await done).toEqual({ code: null, signal: 'SIGTERM' });
    expect(process.listeners('SIGTERM').filter((l) => !before.has(l))).toEqual([]);
  });

  it('keeps stdin and stdout inherited (the MCP channel) and pipes only stderr', async () => {
    const { source } = doppler({ secrets: { GH_PAT: DOPPLER_VALUE } });
    const fake = fakeSpawn(0);
    await runLauncher(argvFor(STDIO), { secrets: () => source, env: {}, stderr: write, spawn: fake.spawn as never });
    expect(fake.calls[0].stdio).toEqual(['inherit', 'inherit', 'pipe']);
  });
});

describe('redactor', () => {
  it('replaces the verbatim and the JSON-escaped form of each value', () => {
    const v = 'fake"quoted\\value';
    const redact = redactor([v]);
    expect(redact(`raw=${v}`)).toBe('raw=[redacted]');
    expect(redact(JSON.stringify({ token: v }))).toBe('{"token":"[redacted]"}');
  });

  it('matches each line of a multi-line value, split on \\n, \\r\\n or \\r', () => {
    const redact = redactor(['first-line\r\nsecond-line\rthird-line']);
    expect(['first-line', 'second-line', 'third-line'].map(redact)).toEqual(['[redacted]', '[redacted]', '[redacted]']);
  });

  it('leaves values shorter than 4 characters alone', () => {
    expect(redactor(['dev'])('dev server started')).toBe('dev server started');
  });
});

describe('pipeRedacted', () => {
  function pipe(values: string[]) {
    const stream = new PassThrough();
    const out: string[] = [];
    const flush = pipeRedacted(stream, redactor(values), (text) => { out.push(text); });
    return { stream, out, flush };
  }
  const tick = () => new Promise((r) => setImmediate(r));

  it('treats a lone \\r as a line end, so \\r-only progress output flushes', async () => {
    const { stream, out } = pipe([DOPPLER_VALUE]);
    stream.write(`10%\r50%\r${DOPPLER_VALUE}\rdone\n`);
    await tick();
    expect(out.join('')).toBe('10%\n50%\n[redacted]\ndone\n');
  });

  it('a \\r\\n split across two chunks is one line end, not two', async () => {
    const { stream, out } = pipe([DOPPLER_VALUE]);
    stream.write('first\r');
    await tick();
    stream.write('\nsecond\n');
    await tick();
    expect(out.join('')).toBe('first\nsecond\n');
  });

  it('flush writes a partial last line, dropping a trailing \\r', async () => {
    const { stream, out, flush } = pipe([DOPPLER_VALUE]);
    stream.write(`tail ${DOPPLER_VALUE}\r`);
    await tick();
    flush();
    expect(out.join('')).toBe('tail [redacted]\n');
  });

  it('holds at most 64 Ki characters of an unterminated line, writing the rest through in pieces', async () => {
    const { stream, out, flush } = pipe([DOPPLER_VALUE]);
    const BIG = 'z'.repeat(300 * 1024);
    for (let i = 0; i < BIG.length; i += 16 * 1024) { stream.write(BIG.slice(i, i + 16 * 1024)); await tick(); }
    expect(BIG.length - out.join('').length).toBeLessThanOrEqual(64 * 1024);
    expect(Math.max(...out.map((s) => s.length))).toBeLessThanOrEqual(64 * 1024);
    flush();
    expect(out.join('')).toBe(BIG + '\n');
  });
});

describe('integration log file', () => {
  const sb = sandboxEach();

  // Pids above the largest one Linux or macOS can assign (2^22): never alive.
  const DEAD = (i: number) => 4194305 + i;
  const logDir = () => path.join(sb.secretsDir, 'logs', 'integrations');
  const line100 = (tag: string) => `${tag.padEnd(99, '.')}\n`;

  it('lives at <secretsDir>/logs/integrations/<name>.<pid>.log, the name reduced to [A-Za-z0-9_-]', () => {
    expect(integrationLogPath(sb.secretsDir, 'linear')).toBe(path.join(logDir(), `linear.${process.pid}.log`));
    expect(integrationLogPath(sb.secretsDir, 'linear', 42)).toBe(path.join(logDir(), 'linear.42.log'));
    expect(integrationLogPath(sb.secretsDir, '../../etc/x y', 42)).toBe(path.join(logDir(), '______etc_x_y.42.log'));
    expect(integrationLogPath(sb.secretsDir, '', 42)).toBe(path.join(logDir(), 'integration.42.log'));
  });

  it('creates the dir 0700 (tightening a looser one) and a new file 0600', () => {
    fs.mkdirSync(logDir(), { recursive: true, mode: 0o755 });
    fs.chmodSync(logDir(), 0o755);
    const file = integrationLogPath(sb.secretsDir, 'linear');
    const log = openIntegrationLog(file);
    log.write('hello\n');
    log.close();
    expect(fs.statSync(logDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('hello\n');
  });

  it('replaces a leftover file at its own path (an earlier process with the same pid) with a fresh 0600 one', () => {
    const file = integrationLogPath(sb.secretsDir, 'linear');
    fs.mkdirSync(logDir(), { recursive: true });
    fs.writeFileSync(file, 'old run\n', { mode: 0o644 });
    const log = openIntegrationLog(file);
    log.write('new run\n');
    log.close();
    expect(fs.readFileSync(file, 'utf8')).toBe('new run\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('rotates once to .log.1 (0600) past the cap and reopens the active path at once', () => {
    const file = integrationLogPath(sb.secretsDir, 'linear');
    const log = openIntegrationLog(file, 1000);
    for (let i = 0; i < 30; i++) log.write(line100(`line ${i}`));
    log.close();
    expect(fs.statSync(file).size).toBeLessThanOrEqual(1000);
    expect(fs.statSync(`${file}.1`).size).toBeGreaterThan(1000);
    expect(fs.statSync(`${file}.1`).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${file}.2`)).toBe(false);
  });

  it('closing right after a rotating write leaves the active path present (the path the harness line names)', () => {
    const file = integrationLogPath(sb.secretsDir, 'linear');
    const log = openIntegrationLog(file, 1000);
    log.write(line100('fill').repeat(11)); // this write crosses the cap and rotates
    log.close();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toContain('fill');
  });

  describe('pruneIntegrationLogs', () => {
    const DAY = 24 * 60 * 60 * 1000;
    /** Create a log file with a given age (ms) and mode. */
    function make(name: string, ageMs: number, mode = 0o600): string {
      const f = path.join(logDir(), name);
      fs.mkdirSync(logDir(), { recursive: true });
      fs.writeFileSync(f, `${name}\n`, { mode });
      fs.chmodSync(f, mode);
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(f, t, t);
      return f;
    }
    const exists = (name: string) => fs.existsSync(path.join(logDir(), name));
    const modeOf = (name: string) => fs.statSync(path.join(logDir(), name)).mode & 0o777;

    it('keeps live-pid files and the 5 newest dead runs; deletes older dead runs and the old shared files', () => {
      make(`linear.${process.pid}.log`, 10 * DAY); // live: never touched, however old
      for (let i = 1; i <= 7; i++) make(`linear.${DEAD(i)}.log`, i * 60_000); // dead runs, newest first
      make(`linear.${DEAD(6)}.log.1`, 6 * 60_000);
      make('linear.log', 60_000); // the shared log of earlier builds: abandoned
      make('linear.log.1', 60_000);
      pruneIntegrationLogs(sb.secretsDir, 'linear');
      expect(exists(`linear.${process.pid}.log`)).toBe(true);
      for (let i = 1; i <= 5; i++) expect(exists(`linear.${DEAD(i)}.log`)).toBe(true);
      expect(exists(`linear.${DEAD(6)}.log`)).toBe(false);
      expect(exists(`linear.${DEAD(6)}.log.1`)).toBe(false);
      expect(exists(`linear.${DEAD(7)}.log`)).toBe(false);
      expect(exists('linear.log')).toBe(false);
      expect(exists('linear.log.1')).toBe(false);
    });

    it('deletes a dead run older than 7 days even when it is among the newest 5', () => {
      make(`linear.${DEAD(1)}.log`, 60_000);
      make(`linear.${DEAD(2)}.log`, 8 * DAY);
      make(`linear.${DEAD(2)}.log.1`, 8 * DAY);
      pruneIntegrationLogs(sb.secretsDir, 'linear');
      expect(exists(`linear.${DEAD(1)}.log`)).toBe(true);
      expect(exists(`linear.${DEAD(2)}.log`)).toBe(false);
      expect(exists(`linear.${DEAD(2)}.log.1`)).toBe(false);
    });

    it('tightens a kept 0644 file (an old backup) to 0600', () => {
      make(`linear.${DEAD(1)}.log`, 60_000, 0o644);
      make(`linear.${DEAD(1)}.log.1`, 60_000, 0o644);
      pruneIntegrationLogs(sb.secretsDir, 'linear');
      expect(modeOf(`linear.${DEAD(1)}.log`)).toBe(0o600);
      expect(modeOf(`linear.${DEAD(1)}.log.1`)).toBe(0o600);
    });

    it('parses names strictly: other integrations and unrelated files are never touched', () => {
      const others = [
        `other.${DEAD(1)}.log`, `linear-2.${DEAD(1)}.log`, `linear.abc.log`, `linear.${DEAD(1)}.log.2`,
        `linear.${DEAD(1)}.txt`, `linear.${DEAD(1)}.log.lock`, 'linear.log.bak', 'notes.md',
      ];
      for (const n of others) make(n, 30 * DAY, 0o644);
      pruneIntegrationLogs(sb.secretsDir, 'linear');
      for (const n of others) {
        expect(exists(n)).toBe(true);
        expect(modeOf(n)).toBe(0o644);
      }
    });

    it('is a no-op without a log dir', () => {
      expect(() => pruneIntegrationLogs(sb.secretsDir, 'linear')).not.toThrow();
    });
  });
});

describe('runLauncher never writes a resolved value to stderr', () => {
  const SENSITIVE = 'fake-sensitive-value';
  let stderr: string[];
  const write = (line: string) => { stderr.push(line); };
  beforeEach(() => { stderr = []; });

  it.each([['CR', '\r'], ['LF', '\n'], ['NUL', '\x00']])('refuses a header value with %s, naming only the ref', async (_label, ch) => {
    const { source } = doppler({ secrets: { LINEAR_TOKEN: `${SENSITIVE}${ch}X-Injected: 1` } });
    const fake = fakeSpawn(0);
    const res = await runLauncher(argvFor(REMOTE), { secrets: () => source, env: {}, stderr: write, spawn: fake.spawn as never });
    expect(res.code).toBe(1);
    expect(fake.spawn).not.toHaveBeenCalled();
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('${LINEAR_TOKEN}');
    expect(stderr.join('\n')).not.toContain(SENSITIVE);
  });

  it('allows a line break in a stdio env value (only a header cannot hold one)', async () => {
    const { source } = doppler({ secrets: { GH_PAT: `${SENSITIVE}\nline-two` } });
    const fake = fakeSpawn(0);
    const res = await runLauncher(argvFor(STDIO), { secrets: () => source, env: {}, stderr: write, spawn: fake.spawn as never });
    expect(res.code).toBe(0);
    expect(fake.calls[0].env.GITHUB_TOKEN).toBe(`${SENSITIVE}\nline-two`);
  });

  it('a spawn "error" event prints its code and the command, never its message', async () => {
    const fake = fakeSpawn(0, { error: errorQuoting(SENSITIVE, 'ENOENT') });
    const { source } = doppler({ secrets: { GH_PAT: SENSITIVE } });
    const res = await runLauncher(argvFor(STDIO), { secrets: () => source, env: {}, stderr: write, spawn: fake.spawn as never });
    expect(res.code).toBe(127);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/could not start npx: ENOENT$/);
    expect(stderr.join('\n')).not.toContain(SENSITIVE);
  });

  it('a synchronous spawn throw prints its code and the command, never its message', async () => {
    const fake = fakeSpawn(0, { throws: errorQuoting(SENSITIVE, 'ERR_INVALID_ARG_VALUE') });
    const { source } = doppler({ secrets: { GH_PAT: SENSITIVE } });
    const res = await runLauncher(argvFor(STDIO), { secrets: () => source, env: {}, stderr: write, spawn: fake.spawn as never });
    expect(res.code).toBe(1);
    expect(stderr[0]).toMatch(/could not start npx: ERR_INVALID_ARG_VALUE$/);
    expect(stderr.join('\n')).not.toContain(SENSITIVE);
  });
});

describe('runLauncher with a real child and a real SecretsService', () => {
  const sb = sandboxEach();
  const savedToken = process.env.DOPPLER_TOKEN;
  beforeEach(() => { delete process.env.DOPPLER_TOKEN; });
  afterEach(() => { if (savedToken !== undefined) process.env.DOPPLER_TOKEN = savedToken; });

  /** The real spawn, with the child's cwd pinned inside the sandbox. */
  const inSandbox = (cmd: string, args: string[], opts: SpawnOptions) => spawn(cmd, args, { ...opts, cwd: sb.workDir });
  /** A stdio spec that runs `code` under this node, with KEY = the value of ${API_KEY}. The value never appears in `code`. */
  const nodeSpec = (code: string): LaunchSpec => ({ name: 'probe', type: 'stdio', command: process.execPath, args: ['-e', code], env: { KEY: '${API_KEY}' } });
  const argvIn = (spec: LaunchSpec) => launcherArgs('/x/launcher.js', sb.secretsDir, spec).slice(1);
  const logFile = () => integrationLogPath(sb.secretsDir, 'probe');

  it('the stdio server sees the Doppler value in its env and the launcher returns its exit code', async () => {
    const client = { verify: async () => true, getSecret: async (_p: string, _c: string, n: string) => (n === 'API_KEY' ? DOPPLER_VALUE : null) } as never;
    await new SecretsService(sb.secretsDir, () => client).setConnection({ token: 'fake-token', project: 'acme', config: 'dev' });
    // The child reports the value's LENGTH as its exit code, so the value itself stays out of this argv too.
    const res = await runLauncher(argvIn(nodeSpec('process.exit((process.env.KEY ?? "").length)')), {
      secrets: (d) => new SecretsService(d, () => client), env: process.env, stderr: () => {}, spawn: inSandbox as never,
    });
    expect(res).toEqual({ code: DOPPLER_VALUE.length, signal: null });
  });

  it('refuses a value with a NUL byte before spawning, naming only the ref', async () => {
    // The real spawn throws ERR_INVALID_ARG_VALUE for a NUL in env, and its message quotes the value.
    const SENSITIVE = 'fake-sensitive-value';
    const spawnSpy = vi.fn(inSandbox);
    const stderr: string[] = [];
    const res = await runLauncher(argvIn(nodeSpec('process.exit(0)')), {
      secrets: () => doppler({ secrets: { API_KEY: `${SENSITIVE}\x00` } }).source, env: {}, stderr: (l) => { stderr.push(l); }, spawn: spawnSpy as never,
    });
    expect(res).toEqual({ code: 1, signal: null });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('${API_KEY}');
    expect(stderr.join('\n')).not.toContain(SENSITIVE);
  });

  it('sends the server stderr to its 0600 log, redacted, and nothing to the harness on a clean exit', async () => {
    const lines: string[] = [];
    const code = [
      'const v = process.env.KEY;',
      'process.stderr.write("tok=" + v.slice(0, 5));',
      'setTimeout(() => { process.stderr.write(v.slice(5) + " end\\n"); process.stderr.write("partial " + v); }, 100);',
    ].join(' ');
    const res = await runLauncher(argvIn(nodeSpec(code)), {
      secrets: () => doppler({ secrets: { API_KEY: DOPPLER_VALUE } }).source, env: process.env, stderr: (l) => { lines.push(l); }, spawn: inSandbox as never,
    });
    expect(res).toEqual({ code: 0, signal: null });
    expect(lines).toEqual([]);
    expect(fs.statSync(path.dirname(logFile())).mode & 0o777).toBe(0o700);
    expect(fs.statSync(logFile()).mode & 0o777).toBe(0o600);
    const log = fs.readFileSync(logFile(), 'utf8');
    expect(log).toContain('tok=[redacted] end\npartial [redacted]\n');
    expect(log).not.toContain(DOPPLER_VALUE);
  });

  it('the harness never sees a value (inspect-escaped, 3 characters, or in a long unterminated line); a failure gets one fixed line', async () => {
    // util.inspect escapes \x01 and, with all three quote kinds present, the quotes too: no filter can enumerate that.
    const ESCAPED = 'fake\x01"quoted`back\'tick-value';
    const SHORT = '~~^'; // under the redaction minimum, and no character mkdtemp puts in the log path
    const spec: LaunchSpec = {
      ...nodeSpec([
        'console.error({ token: process.env.A });',
        'process.stderr.write("short=" + process.env.B + "\\n");',
        'process.stderr.write(("y".repeat(1000) + process.env.A).repeat(200));',
        'process.exitCode = 2;',
      ].join(' ')),
      env: { A: '${ESCAPED_REF}', B: '${SHORT_REF}' },
    };
    const lines: string[] = [];
    const res = await runLauncher(argvIn(spec), {
      secrets: () => doppler({ secrets: { ESCAPED_REF: ESCAPED, SHORT_REF: SHORT } }).source, env: process.env, stderr: (l) => { lines.push(l); }, spawn: inSandbox as never,
    });
    expect(res).toEqual({ code: 2, signal: null });
    expect(lines).toEqual([`dispatch integration "probe": exited with code 2; its stderr is in ${logFile()}`]);
    for (const leak of [ESCAPED, SHORT, 'quoted', 'tick-value', 'y'.repeat(50)]) expect(lines.join('\n')).not.toContain(leak);
    // The log is the restricted channel: it holds the output, partly redacted, which is why it is 0600.
    const log = fs.readFileSync(logFile(), 'utf8');
    expect(log).toContain(`short=${SHORT}\n`);
    expect(log).toContain('[redacted]');
  });

  /**
   * The real entry point as its own process (tsx's loader, no build), cwd in the sandbox, so its
   * stdout and stderr can be captured. The sandbox secrets dir has no Doppler connection, so
   * ${API_KEY} comes from the env fallback (no network).
   */
  function startEntry(spec: LaunchSpec) {
    const coreDir = fileURLToPath(new URL('../..', import.meta.url));
    const loader = pathToFileURL(path.join(coreDir, 'node_modules/tsx/dist/loader.mjs')).href;
    const env: NodeJS.ProcessEnv = { ...process.env, API_KEY: ENV_VALUE };
    delete env.DOPPLER_TOKEN;
    return spawn(process.execPath, ['--import', loader, path.join(coreDir, 'src/integrations/launcher.ts'), ...argvIn(spec)], { cwd: sb.workDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  it('end to end: a slow stderr reader still gets the final fixed line, and the log gets every server line', async () => {
    const LINES = 4000;
    const p = startEntry(nodeSpec(`const pad = "x".repeat(100); for (let i = 0; i < ${LINES}; i++) process.stderr.write("line " + i + " " + pad + "\\n"); process.stderr.write("FATAL last line\\n"); process.exitCode = 3;`));
    const closed = new Promise<number | null>((resolve) => p.on('close', (c) => resolve(c)));
    p.stdout!.resume();
    // Listen now, then pause: an unlistened stdio stream is resumed (and drained) by Node when the child exits.
    let err = '';
    p.stderr!.setEncoding('utf8');
    p.stderr!.on('data', (s: string) => { err += s; });
    p.stderr!.pause();
    await new Promise((r) => setTimeout(r, 1500));
    p.stderr!.resume();
    expect(await closed).toBe(3);
    // The launcher runs in the spawned node process itself, so its log is named by that pid.
    const file = integrationLogPath(sb.secretsDir, 'probe', p.pid);
    expect(err.trim().split('\n').at(-1)).toBe(`dispatch integration "probe": exited with code 3; its stderr is in ${file}`);
    expect(err).not.toContain('line 0 ');
    const log = fs.readFileSync(file, 'utf8');
    expect(log.split('\n').filter((l) => l.startsWith('line '))).toHaveLength(LINES);
    expect(log).toContain('FATAL last line\n');
  });

  it('end to end: two launchers of one integration run at once, and each log file holds only its own lines', async () => {
    const tagged = (tag: string) => startEntry(nodeSpec(`for (let i = 0; i < 500; i++) process.stderr.write("${tag} " + i + "\\n");`));
    const a = tagged('from-A');
    const b = tagged('from-B');
    const done = (p: ReturnType<typeof startEntry>) => new Promise<number | null>((resolve) => { p.stdout!.resume(); p.stderr!.resume(); p.on('close', (c) => resolve(c)); });
    expect(await Promise.all([done(a), done(b)])).toEqual([0, 0]);
    const logA = fs.readFileSync(integrationLogPath(sb.secretsDir, 'probe', a.pid), 'utf8');
    const logB = fs.readFileSync(integrationLogPath(sb.secretsDir, 'probe', b.pid), 'utf8');
    expect(logA.split('\n').filter((l) => l.startsWith('from-A '))).toHaveLength(500);
    expect(logB.split('\n').filter((l) => l.startsWith('from-B '))).toHaveLength(500);
    expect(logA).not.toContain('from-B');
    expect(logB).not.toContain('from-A');
  });

  it('end to end: the server stdout bytes pass through unchanged, and its stderr goes only to the log', async () => {
    const BYTES = [0x7b, 0x22, 0x61, 0x22, 0x7d, 0x0a, 0x00, 0xff, 0x0d, 0x0a];
    const p = startEntry(nodeSpec(`process.stdout.write(Buffer.from(${JSON.stringify(BYTES)})); process.stderr.write("key=" + process.env.KEY + "\\n");`));
    const out: Buffer[] = [];
    let err = '';
    p.stdout!.on('data', (b: Buffer) => out.push(b));
    p.stderr!.on('data', (b: Buffer) => { err += b.toString('utf8'); });
    const exitCode = await new Promise<number | null>((resolve) => p.on('close', (c) => resolve(c)));
    expect(exitCode).toBe(0);
    expect(Buffer.concat(out)).toEqual(Buffer.from(BYTES));
    expect(err).not.toContain('key=');
    expect(err).not.toContain(ENV_VALUE);
    expect(fs.readFileSync(integrationLogPath(sb.secretsDir, 'probe', p.pid), 'utf8')).toContain('key=[redacted]\n');
  });
});
