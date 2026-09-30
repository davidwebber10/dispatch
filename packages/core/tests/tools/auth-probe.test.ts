import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolAuthProber, type AuthCheckRunner, type AuthCheckOutcome } from '../../src/tools/auth-probe.js';
import { loadManifest } from '../../src/tools/manifest.js';
import { getToolsSpawnEnv } from '../../src/tools/spawnEnv.js';
import { toolPaths } from '../../src/tools/paths.js';
import { toolStatuses } from '../../src/tools/status.js';

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  it('checks each installed tool with an authCheck, in parallel, and records each outcome', async () => {
    writeManifest([entry('alpha', { args: ['whoami'] }), entry('beta', { shell: 'beta ping' }), entry('plain'), entry('absent', { args: ['x'] })]);
    installBin('alpha'); installBin('beta'); installBin('plain'); // 'absent' is not installed
    const calls: { cmd: string; args: string[] }[] = [];
    const pending: ((o: AuthCheckOutcome) => void)[] = [];
    const run: AuthCheckRunner = (cmd, args) => { calls.push({ cmd, args }); return new Promise((r) => pending.push(r)); };
    const prober = new ToolAuthProber({ base, env: {}, run });
    const done = prober.refresh();
    await vi.waitFor(() => expect(calls).toHaveLength(2)); // both started before either finished
    expect(calls).toContainEqual({ cmd: path.join(bin, 'alpha'), args: ['whoami'] });
    expect(calls).toContainEqual({ cmd: '/bin/sh', args: ['-c', 'beta ping'] });
    const alphaFirst = calls[0].cmd.endsWith('alpha');
    pending[alphaFirst ? 0 : 1]('ok');
    pending[alphaFirst ? 1 : 0]('failed');
    const snap = await done;
    expect(snap.results).toEqual({ alpha: 'ok', beta: 'failed' });
    expect(Number.isNaN(Date.parse(snap.checkedAt!))).toBe(false);
    expect(prober.snapshot()).toEqual(snap);
  });

  it('a rejecting, throwing, or junk-returning runner is unknown, and refresh never throws', async () => {
    writeManifest([entry('a', { args: ['x'] }), entry('b', { args: ['x'] }), entry('c', { args: ['x'] })]);
    for (const n of ['a', 'b', 'c']) installBin(n);
    const run: AuthCheckRunner = (cmd) => {
      if (cmd.endsWith('/a')) return Promise.reject(new Error('boom'));
      if (cmd.endsWith('/b')) throw new Error('sync boom');
      return Promise.resolve(true as unknown as AuthCheckOutcome);
    };
    const snap = await new ToolAuthProber({ base, env: {}, run }).refresh();
    expect(snap.results).toEqual({ a: 'unknown', b: 'unknown', c: 'unknown' });
  });

  it('a check that outlives its timeout is unknown and is aborted', async () => {
    writeManifest([entry('slow', { args: ['x'] }), entry('quick', { args: ['x'], timeoutMs: 20 })]);
    installBin('slow'); installBin('quick');
    const aborted: string[] = [];
    const run: AuthCheckRunner = (cmd, _args, { signal }) => new Promise(() => {
      signal.addEventListener('abort', () => aborted.push(path.basename(cmd)));
    });
    const t0 = Date.now();
    const snap = await new ToolAuthProber({ base, env: {}, run, timeoutMs: 40 }).refresh();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(snap.results).toEqual({ slow: 'unknown', quick: 'unknown' });
    expect(aborted.sort()).toEqual(['quick', 'slow']);
  });

  it('caches results for the TTL and reports stale after it', async () => {
    writeManifest([entry('alpha', { args: ['x'] })]);
    installBin('alpha');
    let now = 1_000_000;
    const run = vi.fn<AuthCheckRunner>(async () => 'ok');
    const prober = new ToolAuthProber({ base, env: {}, run, ttlMs: 1000, now: () => now });
    expect(prober.isStale()).toBe(true);
    expect(prober.snapshot()).toEqual({ results: {}, checkedAt: null });
    await prober.refresh();
    expect(prober.snapshot().checkedAt).toBe(new Date(1_000_000).toISOString());
    now += 1000;
    expect(prober.isStale()).toBe(false);
    now += 1;
    expect(prober.isStale()).toBe(true);
    expect(prober.snapshot().results).toEqual({ alpha: 'ok' }); // stale results still serve
  });

  it('dedupes concurrent refreshes into one run', async () => {
    writeManifest([entry('alpha', { args: ['x'] })]);
    installBin('alpha');
    let release!: (o: AuthCheckOutcome) => void;
    const run = vi.fn<AuthCheckRunner>(() => new Promise((r) => { release = r; }));
    const prober = new ToolAuthProber({ base, env: {}, run });
    const one = prober.refresh();
    const two = prober.refresh();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    release('ok');
    expect(await one).toEqual(await two);
    expect(run).toHaveBeenCalledTimes(1);
    run.mockImplementation(async () => 'failed');
    expect((await prober.refresh()).results).toEqual({ alpha: 'failed' }); // a later refresh runs again
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs every check with the thread env (the base env overlaid with the latest spawn env) and its unknownExitCodes', async () => {
    writeManifest([entry('alpha', { args: ['x'], unknownExitCodes: [124] })]);
    installBin('alpha');
    const seen: { env: Record<string, string>; cwd?: string; unknownExitCodes?: number[] }[] = [];
    const run: AuthCheckRunner = async (_c, _a, { env, cwd, unknownExitCodes }) => { seen.push({ env, cwd, unknownExitCodes }); return 'ok'; };
    const prober = new ToolAuthProber({ base, env: { HOME: '/home/fake', PATH: SYS_PATH, UNSET: undefined }, run, cwd: root });
    prober.setSpawnEnv({ PATH: `${bin}:${SYS_PATH}`, DOPPLER_TOKEN: 'dp.st.fake' });
    await prober.refresh();
    const want = { HOME: '/home/fake', PATH: `${bin}:${SYS_PATH}`, DOPPLER_TOKEN: 'dp.st.fake' };
    expect(seen[0]).toEqual({ env: want, cwd: root, unknownExitCodes: [124] });
    expect(prober.threadEnv()).toEqual(want);
  });
});

describe('ToolAuthProber when the thread env changes', () => {
  beforeEach(() => { writeManifest([entry('alpha', { args: ['x'] })]); installBin('alpha'); });

  it('a changed env invalidates the cache (e.g. a Doppler disconnect); the same values again do not', async () => {
    const run = vi.fn<AuthCheckRunner>(async () => 'ok');
    const prober = new ToolAuthProber({ base, env: { PATH: SYS_PATH }, run });
    prober.setSpawnEnv({ DOPPLER_TOKEN: 'dp.st.fake' });
    await prober.refresh();
    prober.setSpawnEnv({ DOPPLER_TOKEN: 'dp.st.fake' }); // a new object with the same values
    expect(prober.isStale()).toBe(false);
    expect(prober.snapshot().results).toEqual({ alpha: 'ok' });
    prober.setSpawnEnv({}); // disconnected
    expect(prober.isStale()).toBe(true);
    expect(prober.snapshot()).toEqual({ results: {}, checkedAt: null });
  });

  it('a run that started under an older env does not publish its result', async () => {
    let release!: (o: AuthCheckOutcome) => void;
    const run = vi.fn<AuthCheckRunner>(() => new Promise((r) => { release = r; }));
    const prober = new ToolAuthProber({ base, env: { PATH: SYS_PATH }, run });
    prober.setSpawnEnv({ DOPPLER_TOKEN: 'dp.st.old' });
    const p = prober.refresh();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    prober.setSpawnEnv({});
    release('ok');
    await p;
    expect(prober.snapshot()).toEqual({ results: {}, checkedAt: null });
    expect(prober.isStale()).toBe(true);
  });

  it('a refresh after an env change starts its own run, and the older run cannot overwrite it', async () => {
    const calls: { token?: string; release: (o: AuthCheckOutcome) => void }[] = [];
    const run: AuthCheckRunner = (_c, _a, { env }) => new Promise((r) => { calls.push({ token: env.DOPPLER_TOKEN, release: r }); });
    let now = 1_000_000;
    const prober = new ToolAuthProber({ base, env: { PATH: SYS_PATH }, run, now: () => now });
    prober.setSpawnEnv({ DOPPLER_TOKEN: 'dp.st.old' });
    const oldRun = prober.refresh();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    prober.setSpawnEnv({ DOPPLER_TOKEN: 'dp.st.new' });
    const checkAgain = prober.refresh(); // must not join the run that started under the old env
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].token).toBe('dp.st.new');
    expect(prober.refresh()).toBe(checkAgain); // same env: this one does join
    now += 5;
    calls[1].release('failed');
    expect((await checkAgain).results).toEqual({ alpha: 'failed' });
    calls[0].release('ok');
    await oldRun;
    expect(prober.snapshot()).toEqual({ results: { alpha: 'failed' }, checkedAt: new Date(1_000_005).toISOString() });
    expect(calls).toHaveLength(2);
  });

  it('A→B→A: only the newest run publishes, even when an older run checked the same env', async () => {
    const calls: { token?: string; release: (o: AuthCheckOutcome) => void }[] = [];
    const run: AuthCheckRunner = (_c, _a, { env }) => new Promise((r) => { calls.push({ token: env.DOPPLER_TOKEN, release: r }); });
    let now = 1_000_000;
    const prober = new ToolAuthProber({ base, env: { PATH: SYS_PATH }, run, now: () => now });
    prober.setSpawnEnv({ DOPPLER_TOKEN: 'dp.st.a' });
    const first = prober.refresh();
    prober.setSpawnEnv({ DOPPLER_TOKEN: 'dp.st.b' });
    const middle = prober.refresh();
    prober.setSpawnEnv({ DOPPLER_TOKEN: 'dp.st.a' }); // back to A
    const newest = prober.refresh(); // must not join `first`: the env changed since it started
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map((c) => c.token)).toEqual(['dp.st.a', 'dp.st.b', 'dp.st.a']);
    now += 7;
    calls[2].release('failed');
    expect((await newest).results).toEqual({ alpha: 'failed' });
    now += 100;
    calls[0].release('ok'); // the oldest A run ends last, with a fresher clock
    calls[1].release('ok');
    await Promise.all([first, middle]);
    expect(prober.snapshot()).toEqual({ results: { alpha: 'failed' }, checkedAt: new Date(1_000_007).toISOString() });
  });
});

describe('ToolAuthProber (default runner, fake scripts)', () => {
  it('exit 0 is ok; a non-zero exit (a missing command too) is failed; a spawn error or a signal is unknown', async () => {
    writeManifest([
      entry('ok', { args: ['x'] }), entry('bad', { args: ['x'] }), entry('gone', { shell: `${root}/does-not-exist` }),
      entry('noexec', { args: ['x'] }), entry('killed', { args: ['x'] }),
    ]);
    installBin('ok', 'exit 0'); installBin('bad', 'exit 3'); installBin('gone'); installBin('noexec'); installBin('killed', 'kill -9 $$');
    fs.chmodSync(path.join(bin, 'noexec'), 0o644); // spawn fails with EACCES
    const snap = await new ToolAuthProber({ base, env: { PATH: SYS_PATH }, cwd: root }).refresh();
    expect(snap.results).toEqual({ ok: 'ok', bad: 'failed', gone: 'failed', noexec: 'unknown', killed: 'unknown' });
  });

  it("an exit code listed in the check's unknownExitCodes is unknown; any other non-zero exit is failed", async () => {
    writeManifest([
      entry('timedout', { args: ['x'], unknownExitCodes: [124] }),
      entry('plain124', { args: ['x'] }),
      entry('realfail', { args: ['x'], unknownExitCodes: [124] }),
    ]);
    installBin('timedout', 'exit 124'); installBin('plain124', 'exit 124'); installBin('realfail', 'exit 1');
    const snap = await new ToolAuthProber({ base, env: { PATH: SYS_PATH }, cwd: root }).refresh();
    expect(snap.results).toEqual({ timedout: 'unknown', plain124: 'failed', realfail: 'failed' });
  });

  it('never surfaces what a check prints', async () => {
    const SECRET = 'FAKE-SECRET-4f1c9e';
    writeManifest([entry('loud', { args: ['x'] }), entry('loudfail', { args: ['x'] })]);
    installBin('loud', `echo ${SECRET}; echo ${SECRET} >&2; exit 0`);
    installBin('loudfail', `echo ${SECRET}; echo ${SECRET} >&2; exit 1`);
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    const prober = new ToolAuthProber({ base, env: { PATH: SYS_PATH }, cwd: root });
    const snap = await prober.refresh();
    expect(snap.results).toEqual({ loud: 'ok', loudfail: 'failed' });
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
    expect(snap.results).toEqual({ hang: 'unknown' });
    await sleep(1500);
    expect(fs.existsSync(mark)).toBe(false);
  });

  it('nothing a check started outlives it once it exits', async () => {
    const mark = path.join(root, 'survived');
    writeManifest([entry('leaky', { shell: `(sleep 1; touch "${mark}") & exit 0` })]);
    installBin('leaky');
    const snap = await new ToolAuthProber({ base, env: { PATH: SYS_PATH }, cwd: root }).refresh();
    expect(snap.results).toEqual({ leaky: 'ok' });
    await sleep(1500);
    expect(fs.existsSync(mark)).toBe(false);
  });
});

describe('the default aws check (fake aws on PATH)', () => {
  // The fake answers only with instance metadata off, one attempt, and short per-attempt
  // timeouts. `sts get-caller-identity` succeeds only for FAKE_AWS_OK ('default' is the default
  // chain); every call sleeps FAKE_AWS_SLEEP seconds; FAKE_AWS_SLOW sleeps 2 s, then writes
  // FAKE_AWS_MARK; the names in FAKE_AWS_HANG hang for 30 s (credential resolution that no
  // socket timeout bounds). FAKE_AWS_LOG gets a '+' when a call starts and a '-' when it ends.
  const FAKE_AWS = [
    '[ "$AWS_EC2_METADATA_DISABLED" = "true" ] && [ "$AWS_MAX_ATTEMPTS" = "1" ] || exit 9',
    'if [ "$1 $2" = "configure list-profiles" ]; then printf "%s\\n" "$FAKE_AWS_PROFILES"; exit 0; fi',
    '[ "$1 $2" = "sts get-caller-identity" ] || exit 2',
    'shift 2; prof=default; ct=; rt=',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    --profile) prof=$2; shift 2 ;;',
    '    --cli-connect-timeout) ct=$2; shift 2 ;;',
    '    --cli-read-timeout) rt=$2; shift 2 ;;',
    '    *) exit 2 ;;',
    '  esac',
    'done',
    '[ -n "$ct" ] && [ "$ct" -le 5 ] && [ -n "$rt" ] && [ "$rt" -le 10 ] || exit 8',
    '[ -z "$FAKE_AWS_LOG" ] || echo + >> "$FAKE_AWS_LOG"',
    'case " $FAKE_AWS_HANG " in *" $prof "*) sleep 30 ;; esac',
    'sleep "${FAKE_AWS_SLEEP:-0}"',
    'if [ "$prof" = "$FAKE_AWS_SLOW" ]; then sleep 2; touch "$FAKE_AWS_MARK"; fi',
    '[ -z "$FAKE_AWS_LOG" ] || echo - >> "$FAKE_AWS_LOG"',
    '[ "$prof" = "$FAKE_AWS_OK" ] || exit 255',
    'echo "{\\"Account\\":\\"000000000000\\"}"',
  ].join('\n');

  async function awsProber(fake: Record<string, string>, opts: { timeoutMs?: number } = {}): Promise<ToolAuthProber> {
    const aws = loadManifest(base).find((e) => e.name === 'aws')!;
    writeManifest([{ ...aws, platforms: undefined }]); // run on any host; the check itself is unchanged
    installBin('aws', FAKE_AWS);
    const prober = new ToolAuthProber({ base, env: { PATH: SYS_PATH }, cwd: root, timeoutMs: opts.timeoutMs });
    prober.setSpawnEnv({ ...getToolsSpawnEnv({ base, env: { PATH: SYS_PATH } }), FAKE_AWS_PROFILES: 'dev\nprod', ...fake });
    return prober;
  }
  const probeAws = async (fake: Record<string, string>, opts: { timeoutMs?: number } = {}): Promise<AuthCheckOutcome | undefined> =>
    (await (await awsProber(fake, opts)).refresh()).results.aws;

  it('passes on the default credential chain', async () => { expect(await probeAws({ FAKE_AWS_OK: 'default' })).toBe('ok'); });
  it('falls back to any listed profile', async () => { expect(await probeAws({ FAKE_AWS_OK: 'prod' })).toBe('ok'); });
  it('fails when neither the default chain nor any profile works', async () => { expect(await probeAws({ FAKE_AWS_OK: 'none' })).toBe('failed'); });

  it('passes each profile name as one argument, never as shell code', async () => {
    const odd = 'my team; touch INJECTED *';
    expect(await probeAws({ FAKE_AWS_PROFILES: `dev\n${odd}`, FAKE_AWS_OK: odd })).toBe('ok');
    expect(fs.existsSync(path.join(root, 'INJECTED'))).toBe(false);
  });

  it('tries profiles in parallel, but at most four calls at once', async () => {
    const log = path.join(root, 'aws.log');
    const profiles = Array.from({ length: 9 }, (_, i) => `p${i}`).join('\n');
    expect(await probeAws({ FAKE_AWS_PROFILES: profiles, FAKE_AWS_OK: 'none', FAKE_AWS_SLEEP: '0.3', FAKE_AWS_LOG: log })).toBe('failed');
    let running = 0; let peak = 0;
    for (const c of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) { running += c === '+' ? 1 : -1; peak = Math.max(peak, running); }
    expect(running).toBe(0);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('succeeds as soon as one profile works, and leaves no call running', async () => {
    const mark = path.join(root, 'slow-call-finished');
    const t0 = Date.now();
    expect(await probeAws({ FAKE_AWS_OK: 'prod', FAKE_AWS_SLOW: 'dev', FAKE_AWS_MARK: mark })).toBe('ok');
    expect(Date.now() - t0).toBeLessThan(1500); // did not wait for the slow 'dev' call
    await sleep(2300);
    expect(fs.existsSync(mark)).toBe(false);
  });

  it('refills a slot as soon as a call ends: a hung early call does not hold back the rest', async () => {
    const profiles = Array.from({ length: 9 }, (_, i) => `p${i}`).join('\n');
    const t0 = Date.now();
    // The default chain hangs; p0–p2 fail fast; the valid profile is the 7th candidate.
    expect(await probeAws({ FAKE_AWS_PROFILES: profiles, FAKE_AWS_HANG: 'default', FAKE_AWS_OK: 'p5' })).toBe('ok');
    expect(Date.now() - t0).toBeLessThan(4000); // well before the hung call's watchdog (~6 s)
  });

  it('a wall-clock watchdog ends each call, so hung calls in every slot still let a later profile run', async () => {
    // All four first slots hang. Only the per-call watchdog can free a slot for p3 inside the
    // 15 s deadline — CLI socket timeouts do not bound credential resolution.
    const t0 = Date.now();
    expect(await probeAws({ FAKE_AWS_PROFILES: 'p0\np1\np2\np3', FAKE_AWS_HANG: 'default p0 p1 p2', FAKE_AWS_OK: 'p3' })).toBe('ok');
    expect(Date.now() - t0).toBeLessThan(12_000);
  });

  it('a call ended by its watchdog, with nothing else succeeding, is unknown — not "needs auth"', async () => {
    // The review's case: no named profiles, and a default chain slower than the 6 s watchdog.
    const prober = await awsProber({ FAKE_AWS_PROFILES: '', FAKE_AWS_HANG: 'default', FAKE_AWS_OK: 'none' });
    const snap = await prober.refresh();
    expect(snap.results.aws).toBe('unknown');
    const aws = toolStatuses({ base, env: prober.threadEnv(), checks: snap.results }).find((t) => t.name === 'aws')!;
    expect(aws.authState).toBe('unknown'); // no env credentials either
  });

  it('a timed-out call counts even when the scan collects it mid-way, before the last profiles fail', async () => {
    // Four hung calls fill every slot; their watchdogs free the slots for p3 and p4, which fail.
    expect(await probeAws({ FAKE_AWS_PROFILES: 'p0\np1\np2\np3\np4', FAKE_AWS_HANG: 'default p0 p1 p2', FAKE_AWS_OK: 'none' })).toBe('unknown');
  });

  it('a scan that cannot finish inside the deadline is unknown, not failed', async () => {
    expect(await probeAws({ FAKE_AWS_OK: 'none', FAKE_AWS_SLEEP: '2' }, { timeoutMs: 300 })).toBe('unknown');
  });
});
