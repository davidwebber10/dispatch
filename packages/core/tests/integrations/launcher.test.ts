import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { spawn, type SpawnOptions } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  encodeLaunchSpec, decodeLaunchSpec, launcherArgs, buildLaunch, runLauncher,
  type LaunchSpec, type SecretSource,
} from '../../src/integrations/launcher.js';
import { SecretsService } from '../../src/secrets/service.js';

// Fake values only. Each test asserts none of them reach argv or the stderr line.
const DOPPLER_VALUE = 'fake-doppler-value-123';
const ENV_VALUE = 'fake-env-value-456';

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

/** A spawn stand-in: records what would run, then exits the "child" with `code`. */
function fakeSpawn(code = 0) {
  const calls: { command: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  const children: (EventEmitter & { kill: ReturnType<typeof vi.fn> })[] = [];
  const spawn = vi.fn((command: string, args: string[], opts: { env: Record<string, string | undefined> }) => {
    calls.push({ command, args, env: opts.env });
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    children.push(child);
    if (code >= 0) setImmediate(() => child.emit('exit', code, null));
    return child;
  });
  return { spawn, calls, children };
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
});

describe('runLauncher with a real child and a real SecretsService', () => {
  // Nested sandbox: the secrets dir and the child's cwd are subdirs of this test's own
  // mkdtemp, and only that mkdtemp (checked to sit directly in the temp dir) is removed.
  const savedToken = process.env.DOPPLER_TOKEN;
  let sandbox: string;
  let secretsDir: string;
  let workDir: string;
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-launcher-'));
    secretsDir = path.join(sandbox, 'secrets');
    workDir = path.join(sandbox, 'work');
    fs.mkdirSync(secretsDir);
    fs.mkdirSync(workDir);
    delete process.env.DOPPLER_TOKEN;
  });
  afterEach(() => {
    if (savedToken !== undefined) process.env.DOPPLER_TOKEN = savedToken;
    if (path.dirname(sandbox) === path.resolve(os.tmpdir()) && path.basename(sandbox).startsWith('dispatch-launcher-')) {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('the stdio server sees the Doppler value in its env and the launcher returns its exit code', async () => {
    const client = { verify: async () => true, getSecret: async (_p: string, _c: string, n: string) => (n === 'API_KEY' ? DOPPLER_VALUE : null) } as never;
    await new SecretsService(secretsDir, () => client).setConnection({ token: 'fake-token', project: 'acme', config: 'dev' });
    // The child reports the value's LENGTH as its exit code, so the value itself stays out of this argv too.
    const spec: LaunchSpec = {
      name: 'probe', type: 'stdio', command: process.execPath,
      args: ['-e', 'process.exit((process.env.KEY ?? "").length)'],
      env: { KEY: '${API_KEY}' },
    };
    const inSandbox = ((cmd: string, args: string[], opts: SpawnOptions) => spawn(cmd, args, { ...opts, cwd: workDir })) as never;
    const res = await runLauncher(launcherArgs('/x/launcher.js', secretsDir, spec).slice(1), {
      secrets: (d) => new SecretsService(d, () => client), env: process.env, stderr: () => {}, spawn: inSandbox,
    });
    expect(res).toEqual({ code: DOPPLER_VALUE.length, signal: null });
  });
});
