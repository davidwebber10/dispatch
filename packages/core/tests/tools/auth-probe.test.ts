import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolAuthProber, type AuthCheckRunner } from '../../src/tools/auth-probe.js';
import { loadManifest } from '../../src/tools/manifest.js';
import { getToolsSpawnEnv } from '../../src/tools/spawnEnv.js';
import { toolPaths } from '../../src/tools/paths.js';

// Every check here runs either an injected runner or a fake script in a temp dir — never a
// real gh/doppler/databricks/aws binary.

let sandbox: string;
let root: string;
let base: string;
let bin: string;
const SYS_PATH = '/usr/bin:/bin';

function writeManifest(tools: unknown[]) {
  fs.writeFileSync(path.join(root, 'tools.json'), JSON.stringify({ tools }));
}
function installBin(name: string, body = 'exit 0') {
  fs.mkdirSync(bin, { recursive: true });
  const f = path.join(bin, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(f, 0o755);
}
const entry = (name: string, authCheck?: unknown) => ({ name, description: name, kind: 'binary', bins: [name], ...(authCheck ? { authCheck } : {}) });

// Everything (manifest, fake bins, the spawned checks' cwd) lives in a subdir of a fresh
// mkdtemp sandbox; only that sandbox is ever deleted.
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-ap-'));
  root = path.join(sandbox, 'work');
  fs.mkdirSync(root);
  base = path.join(root, 'tools');
  bin = toolPaths(base).bin;
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('ToolAuthProber (injected runner)', () => {
  it('checks each installed tool with an authCheck, in parallel, and maps the result to authed', async () => {
    writeManifest([entry('alpha', { args: ['whoami'] }), entry('beta', { shell: 'beta ping' }), entry('plain'), entry('absent', { args: ['x'] })]);
    installBin('alpha'); installBin('beta'); installBin('plain'); // 'absent' is not installed
    const calls: { cmd: string; args: string[] }[] = [];
    const pending: ((ok: boolean) => void)[] = [];
    const run: AuthCheckRunner = (cmd, args) => { calls.push({ cmd, args }); return new Promise((r) => pending.push(r)); };
    const prober = new ToolAuthProber({ base, env: {}, run });
    const done = prober.refresh();
    await vi.waitFor(() => expect(calls).toHaveLength(2)); // both started before either finished
    expect(calls).toContainEqual({ cmd: path.join(bin, 'alpha'), args: ['whoami'] });
    expect(calls).toContainEqual({ cmd: '/bin/sh', args: ['-c', 'beta ping'] });
    const alphaFirst = calls[0].cmd.endsWith('alpha');
    pending[alphaFirst ? 0 : 1](true);
    pending[alphaFirst ? 1 : 0](false);
    const snap = await done;
    expect(snap.results).toEqual({ alpha: true, beta: false });
    expect(Number.isNaN(Date.parse(snap.checkedAt!))).toBe(false);
    expect(prober.snapshot()).toEqual(snap);
  });

  it('counts a rejecting, throwing, or non-true runner as not authed, and never throws', async () => {
    writeManifest([entry('a', { args: ['x'] }), entry('b', { args: ['x'] }), entry('c', { args: ['x'] })]);
    for (const n of ['a', 'b', 'c']) installBin(n);
    const run: AuthCheckRunner = (cmd) => {
      if (cmd.endsWith('/a')) return Promise.reject(new Error('boom'));
      if (cmd.endsWith('/b')) throw new Error('sync boom');
      return Promise.resolve('yes' as unknown as boolean);
    };
    const snap = await new ToolAuthProber({ base, env: {}, run }).refresh();
    expect(snap.results).toEqual({ a: false, b: false, c: false });
  });

  it('a check that outlives its timeout counts as not authed and is aborted', async () => {
    writeManifest([entry('slow', { args: ['x'] }), entry('quick', { args: ['x'], timeoutMs: 20 })]);
    installBin('slow'); installBin('quick');
    const aborted: string[] = [];
    const run: AuthCheckRunner = (cmd, _args, { signal }) => new Promise(() => {
      signal.addEventListener('abort', () => aborted.push(path.basename(cmd)));
    });
    const t0 = Date.now();
    const snap = await new ToolAuthProber({ base, env: {}, run, timeoutMs: 40 }).refresh();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(snap.results).toEqual({ slow: false, quick: false });
    expect(aborted.sort()).toEqual(['quick', 'slow']);
  });

  it('caches results for the TTL and reports stale after it', async () => {
    writeManifest([entry('alpha', { args: ['x'] })]);
    installBin('alpha');
    let now = 1_000_000;
    const run = vi.fn<AuthCheckRunner>(async () => true);
    const prober = new ToolAuthProber({ base, env: {}, run, ttlMs: 1000, now: () => now });
    expect(prober.isStale()).toBe(true);
    expect(prober.snapshot()).toEqual({ results: {}, checkedAt: null });
    await prober.refresh();
    expect(prober.snapshot().checkedAt).toBe(new Date(1_000_000).toISOString());
    now += 1000;
    expect(prober.isStale()).toBe(false);
    now += 1;
    expect(prober.isStale()).toBe(true);
    expect(prober.snapshot().results).toEqual({ alpha: true }); // stale results still serve
  });

  it('dedupes concurrent refreshes into one run', async () => {
    writeManifest([entry('alpha', { args: ['x'] })]);
    installBin('alpha');
    let release!: (ok: boolean) => void;
    const run = vi.fn<AuthCheckRunner>(() => new Promise((r) => { release = r; }));
    const prober = new ToolAuthProber({ base, env: {}, run });
    const one = prober.refresh();
    const two = prober.refresh();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    release(true);
    expect(await one).toEqual(await two);
    expect(run).toHaveBeenCalledTimes(1);
    run.mockImplementation(async () => false);
    expect((await prober.refresh()).results).toEqual({ alpha: false }); // a later refresh runs again
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs every check with the thread env: the base env overlaid with the latest spawn env', async () => {
    writeManifest([entry('alpha', { args: ['x'] })]);
    installBin('alpha');
    const seen: { env: Record<string, string>; cwd?: string }[] = [];
    const run: AuthCheckRunner = async (_c, _a, { env, cwd }) => { seen.push({ env, cwd }); return true; };
    const prober = new ToolAuthProber({ base, env: { HOME: '/home/fake', PATH: SYS_PATH, UNSET: undefined }, run, cwd: root });
    prober.setSpawnEnv({ PATH: `${bin}:${SYS_PATH}`, DOPPLER_TOKEN: 'dp.st.fake' });
    await prober.refresh();
    const want = { HOME: '/home/fake', PATH: `${bin}:${SYS_PATH}`, DOPPLER_TOKEN: 'dp.st.fake' };
    expect(seen[0]).toEqual({ env: want, cwd: root });
    expect(prober.threadEnv()).toEqual(want);
  });
});

describe('ToolAuthProber (default runner, fake scripts)', () => {
  it('maps exit 0 to authed; a non-zero exit, a missing command, or a spawn error to not authed', async () => {
    writeManifest([entry('ok', { args: ['x'] }), entry('bad', { args: ['x'] }), entry('gone', { shell: `${root}/does-not-exist` }), entry('noexec', { args: ['x'] })]);
    installBin('ok', 'exit 0'); installBin('bad', 'exit 3'); installBin('gone'); installBin('noexec');
    fs.chmodSync(path.join(bin, 'noexec'), 0o644); // spawn fails with EACCES
    const snap = await new ToolAuthProber({ base, env: { PATH: SYS_PATH }, cwd: root }).refresh();
    expect(snap.results).toEqual({ ok: true, bad: false, gone: false, noexec: false });
  });

  it('never surfaces what a check prints', async () => {
    const SECRET = 'FAKE-SECRET-4f1c9e';
    writeManifest([entry('loud', { args: ['x'] }), entry('loudfail', { args: ['x'] })]);
    installBin('loud', `echo ${SECRET}; echo ${SECRET} >&2; exit 0`);
    installBin('loudfail', `echo ${SECRET}; echo ${SECRET} >&2; exit 1`);
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    const prober = new ToolAuthProber({ base, env: { PATH: SYS_PATH }, cwd: root });
    const snap = await prober.refresh();
    expect(snap.results).toEqual({ loud: true, loudfail: false });
    expect(JSON.stringify(snap)).not.toContain(SECRET);
    expect(JSON.stringify(prober.snapshot())).not.toContain(SECRET);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(SECRET);
  });

  it('a timeout kills the whole check, children included', async () => {
    const mark = path.join(root, 'survived');
    // The inner shell is a grandchild of the prober; killing only the outer /bin/sh would leave it to write the mark.
    writeManifest([entry('hang', { shell: `/bin/sh -c 'sleep 1; touch "${mark}"'; true`, timeoutMs: 150 })]);
    installBin('hang');
    const snap = await new ToolAuthProber({ base, env: { PATH: SYS_PATH }, cwd: root }).refresh();
    expect(snap.results).toEqual({ hang: false });
    await new Promise((r) => setTimeout(r, 1500));
    expect(fs.existsSync(mark)).toBe(false);
  });
});

describe('the default aws check (fake aws on PATH)', () => {
  // The fake refuses to answer unless instance metadata is disabled, then succeeds only for
  // what FAKE_AWS_OK names: 'default' for the default chain, or a profile name.
  const FAKE_AWS = [
    '[ "$AWS_EC2_METADATA_DISABLED" = "true" ] || exit 9',
    'case "$*" in',
    '  "configure list-profiles") printf "dev\\nprod\\n" ;;',
    '  "sts get-caller-identity") [ "$FAKE_AWS_OK" = "default" ] || exit 255; echo "{\\"Account\\":\\"000000000000\\"}" ;;',
    '  "sts get-caller-identity --profile "*) [ "$FAKE_AWS_OK" = "$4" ] || exit 255 ;;',
    '  *) exit 2 ;;',
    'esac',
  ].join('\n');

  async function probeAws(fakeOk: string): Promise<boolean | undefined> {
    const aws = loadManifest(base).find((e) => e.name === 'aws')!;
    writeManifest([{ ...aws, platforms: undefined }]); // run on any host; the check itself is unchanged
    installBin('aws', FAKE_AWS);
    const prober = new ToolAuthProber({ base, env: { PATH: SYS_PATH }, cwd: root });
    prober.setSpawnEnv({ ...getToolsSpawnEnv({ base, env: { PATH: SYS_PATH } }), FAKE_AWS_OK: fakeOk });
    return (await prober.refresh()).results.aws;
  }

  it('passes on the default credential chain', async () => { expect(await probeAws('default')).toBe(true); });
  it('falls back to any listed profile', async () => { expect(await probeAws('prod')).toBe(true); });
  it('fails when neither the default chain nor any profile works', async () => { expect(await probeAws('none')).toBe(false); });
});
