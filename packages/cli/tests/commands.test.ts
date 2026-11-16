import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mocked at the module level so no test ever shells out for real. index.ts imports
// execFileSync/spawnSync via a plain ESM `import { ... } from 'child_process'`
// (not Node's raw createRequire-based require), so vi.mock intercepts it cleanly.
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execFileSync, spawnSync } from 'child_process';
import { runCommand, lastLines, probeHttp, cmdBuild, cmdRun, cmdUpdate } from '../src/index.js';

// Give both mocks a harmless default implementation so tests that don't care about
// child_process (routing, probe-via-injected-`probe`, etc.) keep behaving as if the
// real commands had succeeded quietly — matching the pre-mock behavior where these
// calls actually ran (and usually succeeded) against the real dev environment.
function resetChildProcessMocks(): void {
  vi.mocked(execFileSync).mockReset().mockImplementation((() => '') as any);
  vi.mocked(spawnSync).mockReset().mockImplementation((() => ({ status: 0, stdout: '', stderr: '' })) as any);
}
resetChildProcessMocks();

beforeEach(() => {
  // The suite may run inside a Dispatch thread: start from a clean thread environment.
  for (const n of ['DISPATCH_AUTH', 'DISPATCH_AUTH_FILE', 'DISPATCH_TERMINAL_ID', 'DISPATCH_TERMINAL', 'DISPATCH_API']) vi.stubEnv(n, '');
});

afterEach(() => {
  resetChildProcessMocks();
  vi.unstubAllEnvs();
});

describe('dispatch CLI routing', () => {
  test('install → daemon.install; status → daemon.status', () => {
    const daemon = { install: vi.fn(), uninstall: vi.fn(), start: vi.fn(), stop: vi.fn(),
      restart: vi.fn(), status: vi.fn(() => ({ loaded: true, pid: 1 })) };
    runCommand(['install'], { daemon, port: 3456 } as any);
    expect(daemon.install).toHaveBeenCalledOnce();
    runCommand(['status'], { daemon, port: 3456 } as any);
    expect(daemon.status).toHaveBeenCalledOnce();
  });
  test('unknown command throws a usage error', () => {
    expect(() => runCommand(['bogus'], {} as any)).toThrow(/usage/i);
  });

  test('tools → toolsRunner with passthrough args', () => {
    const toolsRunner = vi.fn();
    runCommand(['tools', 'install', '--force'], { toolsRunner } as any);
    expect(toolsRunner).toHaveBeenCalledOnce();
    expect(toolsRunner).toHaveBeenCalledWith(['install', '--force']);
  });

  test('release is a recognized command — does not throw unknown-command error', () => {
    // release requires gh and a clean git tree; we just verify routing doesn't throw
    // "usage: dispatch <...>" for 'release'. Any other error (gh not found, dirty tree)
    // is expected and acceptable here since we're testing routing, not release logic.
    expect(() => runCommand(['release'], {} as any)).not.toThrow(/usage/i);
  });
});

describe('status HTTP probe', () => {
  test('prints reachable when probe returns true', () => {
    const daemon = { install: vi.fn(), uninstall: vi.fn(), start: vi.fn(), stop: vi.fn(),
      restart: vi.fn(), status: vi.fn(() => ({ loaded: true, pid: 42 })) };
    const probe = vi.fn(() => true);
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => logged.push(s));
    runCommand(['status'], { daemon, port: 3456, probe } as any);
    expect(logged.some(l => l.includes('reachable'))).toBe(true);
    vi.restoreAllMocks();
  });

  test('prints not responding when probe returns false', () => {
    const daemon = { install: vi.fn(), uninstall: vi.fn(), start: vi.fn(), stop: vi.fn(),
      restart: vi.fn(), status: vi.fn(() => ({ loaded: false })) };
    const probe = vi.fn(() => false);
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => logged.push(s));
    runCommand(['status'], { daemon, port: 3456, probe } as any);
    expect(logged.some(l => l.includes('not responding'))).toBe(true);
    vi.restoreAllMocks();
  });

  test('the reachability probe sends no credential', () => {
    probeHttp(3456);
    const call = vi.mocked(spawnSync).mock.calls.at(-1)!;
    expect(String(call[1])).not.toMatch(/authorization|bearer|dtk_|access-token/i);
  });

  test('probeHttp returns reachable string when probe returns true', () => {
    expect(probeHttp(3456, () => true)).toBe('HTTP: reachable at http://localhost:3456');
  });

  test('probeHttp returns not responding string when probe returns false', () => {
    expect(probeHttp(3456, () => false)).toBe('HTTP: not responding on http://localhost:3456');
  });
});

describe('lastLines', () => {
  test('returns last n lines', () => {
    expect(lastLines('a\nb\nc\nd', 2)).toBe('c\nd');
  });
  test('returns all lines when fewer than n', () => {
    expect(lastLines('a\nb', 10)).toBe('a\nb');
  });
  test('single line with no newline', () => {
    expect(lastLines('hello', 5)).toBe('hello');
  });
  test('trailing newline does not produce an extra empty line', () => {
    expect(lastLines('a\nb\nc\n', 2)).toBe('b\nc');
  });
  test('empty string returns empty string', () => {
    expect(lastLines('', 5)).toBe('');
  });
  test('n=0 returns empty string', () => {
    expect(lastLines('a\nb\nc', 0)).toBe('');
  });
});

describe('cmdBuild', () => {
  test('runs `pnpm install` (with CI=true) before `pnpm -r run build`', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return Buffer.from('');
    }) as any);

    cmdBuild({} as any);

    // Both calls happened, in order: install, then build.
    const pnpmCalls = calls.filter(c => c.cmd === 'pnpm');
    expect(pnpmCalls.length).toBeGreaterThanOrEqual(2);
    expect(pnpmCalls[0].args).toEqual(['install']);
    expect(pnpmCalls[1].args).toEqual(['-r', 'run', 'build']);

    // The install call carried CI=true in its env.
    const installCallArgs = vi.mocked(execFileSync).mock.calls.find(
      (c) => c[0] === 'pnpm' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'install',
    );
    expect(installCallArgs).toBeDefined();
    const installOpts = installCallArgs?.[2] as { env?: Record<string, string> } | undefined;
    expect(installOpts?.env?.CI).toBe('true');
  });
});

// ---- cmdUpdate: one rule (the newest PUBLISHED release whose tag commit is on origin/main) ----

interface GitWorld {
  /** tag -> commit, as origin lists them */
  tags: Record<string, string>;
  main: string[];
  head: string;
  /** child -> parents, for ancestor questions off main */
  ancestors?: Record<string, string[]>;
  dirty?: string;
  branch?: string;
  /** Records every `cmd args` the update ran. */
  calls?: string[];
  lock?: string | (() => string);
}

/** Answers the git questions the shared rule asks; every other command succeeds quietly. */
function wireUpdateGit(w: GitWorld): void {
  const main = new Set(w.main);
  const isAnc = (a: string, b: string): boolean => {
    if (a === b) return true;
    if (b === 'refs/remotes/origin/main') return main.has(a);
    return (w.ancestors?.[b] ?? []).some((p) => isAnc(a, p));
  };
  vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
    w.calls?.push(`${cmd} ${(args ?? []).join(' ')}`);
    if (cmd !== 'git') return '';
    if (args[0] === 'ls-remote') return Object.entries(w.tags).map(([t, c]) => `tagobj\trefs/tags/${t}\n${c}\trefs/tags/${t}^{}`).join('\n') + '\n';
    if (args[0] === 'merge-base') { if (isAnc(args[2], args[3])) return ''; throw Object.assign(new Error('exit 1'), { status: 1 }); }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${w.head}\n`;
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return `${w.branch ?? 'main'}\n`;
    if (args[0] === 'rev-parse' && args[1] === '--verify') throw Object.assign(new Error('exit 1'), { status: 1 });
    if (args[0] === 'rev-parse' && String(args[1]).startsWith('HEAD:')) return `${typeof w.lock === 'function' ? w.lock() : (w.lock ?? 'lock')}\n`;
    if (args[0] === 'status') return w.dirty ?? '';
    return '';
  }) as any);
}

/** GitHub's release list with these published tags. */
const published = (...tags: string[]) => (async () => ({
  ok: true, status: 200,
  json: async () => tags.map((t) => ({ tag_name: t, html_url: '', published_at: '', body: '', draft: false, prerelease: false })),
})) as any;

const mkDaemon = (restart: () => void = () => {}) => ({
  install: vi.fn(), uninstall: vi.fn(), start: vi.fn(), stop: vi.fn(),
  status: vi.fn(() => ({ loaded: true })), restart: vi.fn(restart),
});
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-upd-'));
/** A checkout directory whose core package.json says `version`. */
function checkout(version: string): string {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'packages', 'core'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'packages', 'core', 'package.json'), JSON.stringify({ version }));
  return dir;
}
const WORLD = { tags: { 'v4.7.7': 'c477', 'v4.7.8': 'c478', 'v4.8.0': 'c480' }, main: ['c477', 'c478', 'old'], head: 'old', ancestors: { c478: ['old'] } };

describe('cmdUpdate', () => {
  test('moves to the newest published release on main, then builds, then daemon.restart() — in that order', async () => {
    const calls: string[] = [];
    let n = 0;
    wireUpdateGit({ ...WORLD, calls, lock: () => `hash${++n}` }); // the lockfile changed, so pnpm install runs
    const daemon = mkDaemon(() => { calls.push('daemon.restart'); });

    await cmdUpdate({ daemon, releasesFetch: published('v4.7.7', 'v4.7.8') } as any);

    // The commit is merged, not a tag name, and the tip of main is never pulled.
    const pullIdx = calls.findIndex((c) => c === 'git merge --ff-only c478');
    expect(calls.some((c) => c.startsWith('git pull'))).toBe(false);
    expect(calls).toContain('git fetch origin +refs/heads/main:refs/remotes/origin/main');
    expect(calls.findIndex((c) => c === 'git fetch origin +refs/heads/main:refs/remotes/origin/main')).toBeLessThan(pullIdx);
    const installIdx = calls.findIndex((c) => c === 'pnpm install');
    const buildIdx = calls.findIndex((c) => c === 'pnpm -r run build');
    const restartIdx = calls.findIndex((c) => c === 'daemon.restart');
    expect(pullIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeGreaterThan(pullIdx);
    expect(buildIdx).toBeGreaterThan(installIdx);
    expect(restartIdx).toBeGreaterThan(buildIdx);
    expect(daemon.restart).toHaveBeenCalledOnce();
  });

  test('a higher tag with no published release is never the target (the 4.8.0 case)', async () => {
    const calls: string[] = [];
    wireUpdateGit({ ...WORLD, main: [...WORLD.main, 'c480'], calls });
    await cmdUpdate({ daemon: mkDaemon(), releasesFetch: published('v4.7.8') } as any);
    expect(calls).toContain('git merge --ff-only c478');
    expect(calls.some((c) => c.includes('c480'))).toBe(false);
  });

  test('a published release whose tag is not on main is skipped', async () => {
    const calls: string[] = [];
    wireUpdateGit({ ...WORLD, calls });
    await cmdUpdate({ daemon: mkDaemon(), releasesFetch: published('v4.8.0', 'v4.7.8') } as any);
    expect(calls).toContain('git merge --ff-only c478');
  });

  test('GitHub unreachable stops the update before any move — it does not fall back to the highest tag', async () => {
    const calls: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    wireUpdateGit({ ...WORLD, main: [...WORLD.main, 'c480'], calls });
    const daemon = mkDaemon();
    await expect(cmdUpdate({ daemon, releasesFetch: vi.fn().mockRejectedValue(new Error('offline')) } as any)).rejects.toThrow(/reach GitHub/);
    expect(calls.some((c) => c.startsWith('git merge ') || c.startsWith('git reset'))).toBe(false);
    expect(daemon.restart).not.toHaveBeenCalled();
  });

  test('no published release on main: stops instead of pulling main', async () => {
    const calls: string[] = [];
    wireUpdateGit({ ...WORLD, main: ['old'], calls });
    const daemon = mkDaemon();
    await expect(cmdUpdate({ daemon, releasesFetch: published('v4.7.8') } as any)).rejects.toThrow(/No published release on main/);
    expect(calls.some((c) => c.startsWith('git pull') || c.startsWith('git merge '))).toBe(false);
    expect(daemon.restart).not.toHaveBeenCalled();
  });

  test('a restart() that throws (e.g. linux "not implemented") propagates rather than being swallowed', async () => {
    wireUpdateGit(WORLD);
    const daemon = mkDaemon(() => { throw new Error('restart: not implemented on linux'); });
    await expect(cmdUpdate({ daemon, releasesFetch: published('v4.7.8') } as any)).rejects.toThrow('restart: not implemented on linux');
  });

  test('a dev checkout of main past the release, with the same version, is left where it is', async () => {
    const calls: string[] = [];
    wireUpdateGit({ ...WORLD, head: 'tip', ancestors: { tip: ['c478'] }, calls });
    const repoRoot = checkout('4.7.8');
    const daemon = mkDaemon();
    await cmdUpdate({ daemon, repoRoot, dataDir: repoRoot, releasesFetch: published('v4.7.8') } as any);
    expect(calls.some((c) => c.startsWith('git merge ') || c.startsWith('git reset'))).toBe(false);
    expect(daemon.restart).toHaveBeenCalledOnce();
  });
});

describe('cmdUpdate when this copy runs a version above the newest release (stuck on an unreleased tag)', () => {
  // HEAD x480 is on a branch that is not main; this copy runs 4.8.0, the newest release is 4.7.8.
  const ahead = { ...WORLD, head: 'x480', ancestors: {} };

  test('does NOT move back by itself: stops, says how, changes nothing', async () => {
    const calls: string[] = [];
    wireUpdateGit({ ...ahead, calls });
    const repoRoot = checkout('4.8.0');
    const daemon = mkDaemon();
    await expect(cmdUpdate({ daemon, repoRoot, dataDir: repoRoot, releasesFetch: published('v4.7.8') } as any)).rejects.toThrow(/--switch-back/);
    expect(calls.some((c) => c.startsWith('git reset') || c.startsWith('git merge ') || c.startsWith('git branch'))).toBe(false);
    expect(daemon.restart).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(repoRoot, 'update-status.json'), 'utf8'))).toMatchObject({ state: 'failed', step: 'pull' });
  });

  test('--switch-back keeps a backup branch of the old commit, resets to the release, then builds and restarts', async () => {
    const calls: string[] = [];
    wireUpdateGit({ ...ahead, head: 'abcdef1234567', calls });
    const repoRoot = checkout('4.8.0');
    const daemon = mkDaemon(() => { calls.push('daemon.restart'); });
    await cmdUpdate({ daemon, repoRoot, dataDir: repoRoot, releasesFetch: published('v4.7.8') } as any, ['--switch-back']);
    const branchIdx = calls.indexOf('git branch dispatch-backup/v4.8.0-abcdef1 abcdef1234567');
    const resetIdx = calls.indexOf('git reset --hard c478');
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(branchIdx);
    expect(calls.findIndex((c) => c === 'pnpm -r run build')).toBeGreaterThan(resetIdx);
    expect(calls.indexOf('daemon.restart')).toBeGreaterThan(resetIdx);
  });

  test('--switch-back still refuses a dirty tree, and touches nothing', async () => {
    const calls: string[] = [];
    wireUpdateGit({ ...ahead, dirty: ' M a.ts\n', calls });
    const repoRoot = checkout('4.8.0');
    await expect(cmdUpdate({ daemon: mkDaemon(), repoRoot, dataDir: repoRoot, releasesFetch: published('v4.7.8') } as any, ['--switch-back'])).rejects.toThrow(/clean working tree/);
    expect(calls.some((c) => c.startsWith('git reset') || c.startsWith('git branch'))).toBe(false);
  });

  test('--switch-back on a copy that is merely behind is an ordinary fast-forward', async () => {
    const calls: string[] = [];
    wireUpdateGit({ ...WORLD, calls });
    const repoRoot = checkout('4.7.7');
    await cmdUpdate({ daemon: mkDaemon(), repoRoot, dataDir: repoRoot, releasesFetch: published('v4.7.8') } as any, ['--switch-back']);
    expect(calls).toContain('git merge --ff-only c478');
    expect(calls.some((c) => c.startsWith('git reset'))).toBe(false);
  });

  test('routes `dispatch update --switch-back` to cmdUpdate with the flag', async () => {
    const calls: string[] = [];
    wireUpdateGit({ ...ahead, calls });
    const repoRoot = checkout('4.8.0');
    await runCommand(['update', '--switch-back'], { daemon: mkDaemon(), repoRoot, dataDir: repoRoot, releasesFetch: published('v4.7.8') } as any);
    expect(calls).toContain('git reset --hard c478');
  });
});

describe('cmdUpdate progress file', () => {
  const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'update-status.json'), 'utf8'));
  const releasesFetch = published('v4.7.8');

  test('records each step in order and ends "restarting" just before the restart', async () => {
    const dataDir = tmpDir();
    const seen: string[] = [];
    wireUpdateGit(WORLD);
    const inner = vi.mocked(execFileSync).getMockImplementation()!;
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[], o: any) => {
      if (cmd === 'git') return (inner as any)(cmd, args, o);
      seen.push(`${read(dataDir).step}:${cmd} ${args[0]}`);
      return '';
    }) as any);
    const daemon = mkDaemon(() => { seen.push(`${read(dataDir).state}:restart`); });
    await cmdUpdate({ daemon, dataDir, repoRoot: dataDir, releasesFetch } as any);
    expect(seen.map((x) => x.split(':')[0] + ':' + (x.includes(process.execPath) ? 'node' : x.split(':').slice(1).join(':')))).toEqual(
      ['install:pnpm install', 'build:pnpm -r', 'tools:node', 'restarting:restart']);
    const s = read(dataDir);
    expect(s).toMatchObject({ v: 1, state: 'restarting', step: 'restart', steps: ['pull', 'install', 'build', 'tools', 'restart'], error: null });
    expect(typeof s.pid).toBe('number');
    expect(typeof s.startedAt).toBe('string');
  });

  test('a failed step is recorded with its step and message, and the error still propagates', async () => {
    const dataDir = tmpDir();
    wireUpdateGit(WORLD);
    const inner = vi.mocked(execFileSync).getMockImplementation()!;
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[], o: any) => {
      if (cmd === 'pnpm' && args[0] === '-r') throw new Error('Command failed: pnpm -r run build');
      return (inner as any)(cmd, args, o);
    }) as any);
    await expect(cmdUpdate({ daemon: mkDaemon(), dataDir, repoRoot: dataDir, releasesFetch } as any)).rejects.toThrow('pnpm -r run build');
    expect(read(dataDir)).toMatchObject({ state: 'failed', step: 'build', error: 'Command failed: pnpm -r run build' });
  });

  test('skips pnpm install when the lockfile did not change and node_modules exists', async () => {
    const repoRoot = tmpDir();
    fs.mkdirSync(path.join(repoRoot, 'node_modules'));
    const calls: string[] = [];
    wireUpdateGit({ ...WORLD, calls, lock: 'abc123' });
    await cmdUpdate({ daemon: mkDaemon(), dataDir: repoRoot, repoRoot, releasesFetch } as any);
    expect(calls).not.toContain('pnpm install');
    expect(read(repoRoot).skipped).toEqual(['install']);
  });

  test('runs pnpm install when the lockfile changed', async () => {
    const repoRoot = tmpDir();
    fs.mkdirSync(path.join(repoRoot, 'node_modules'));
    let n = 0;
    const calls: string[] = [];
    wireUpdateGit({ ...WORLD, calls, lock: () => `hash${++n}` });
    await cmdUpdate({ daemon: mkDaemon(), dataDir: repoRoot, repoRoot, releasesFetch } as any);
    expect(calls).toContain('pnpm install');
  });
});

describe('cmdRun', () => {
  test('propagates the child process exit status via process.exit', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 3 } as any);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called');
    }) as any);

    expect(() => cmdRun({ port: 3456, entry: '/fake/server.js' } as any)).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(3);

    exitSpy.mockRestore();
  });
});

describe('dispatch roles', () => {
  /** A fake `fetch` response object — just enough of the Response shape for cmdRoles. */
  function jsonResponse(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  function logged(): { logs: string[]; restore: () => void } {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => { logs.push(s); });
    return { logs, restore: () => spy.mockRestore() };
  }

  test('roles list renders a table row per role', async () => {
    const rolesFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      roles: [
        {
          def: { name: 'nightly-planner', project: 'dispatch', global: false, agentType: 'planner', schedule: { type: 'daily', time: '05:30' }, authority: 'observe', wallClockCapMin: 45 },
          enabled: true,
          nextRunAt: '2026-09-03T05:30:00Z',
          consecutiveFailures: 0,
        },
        {
          def: { name: 'ops-sweep', project: null, global: true, agentType: 'researcher', schedule: { type: 'daily', time: '06:00' }, authority: 'observe', wallClockCapMin: 45 },
          enabled: false,
          nextRunAt: null,
        },
      ],
    }));
    const { logs, restore } = logged();

    await runCommand(['roles', 'list'], { port: 3456, rolesFetch, readOwnerToken: () => 'tok', processEnv: {} } as any);
    restore();

    expect(rolesFetch).toHaveBeenCalledWith('http://localhost:3456/api/roles', { headers: { Authorization: 'Bearer tok' } });
    const out = logs.join('\n');
    expect(out).toContain('nightly-planner');
    expect(out).toContain('dispatch');
    expect(out).toContain('yes');
    expect(out).toContain('2026-09-03T05:30:00Z');
    expect(out).toContain('ops-sweep');
    expect(out).toContain('global');
    expect(out).toContain('no');
  });

  test('roles list surfaces role.md parse failures in an errors section', async () => {
    const rolesFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      roles: [
        {
          def: { name: 'broken', project: null, global: false, agentType: '', schedule: null, authority: 'observe', wallClockCapMin: 45 },
          enabled: false,
          error: 'role.md must start with a --- frontmatter block',
        },
      ],
    }));
    const { logs, restore } = logged();

    await runCommand(['roles', 'list'], { port: 3456, rolesFetch } as any);
    restore();

    const out = logs.join('\n');
    expect(out).toMatch(/errors/i);
    expect(out).toContain('broken');
    expect(out).toContain('role.md must start with a --- frontmatter block');
  });

  test('roles enable <name> POSTs and prints the updated entry', async () => {
    const rolesFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      def: { name: 'nightly-planner', project: 'dispatch', global: false, agentType: 'planner', schedule: {}, authority: 'observe', wallClockCapMin: 45 },
      enabled: true,
      nextRunAt: '2026-09-03T05:30:00Z',
    }));
    const { logs, restore } = logged();

    await runCommand(['roles', 'enable', 'nightly-planner'], { port: 3456, rolesFetch, readOwnerToken: () => 'tok', processEnv: {} } as any);
    restore();

    expect(rolesFetch).toHaveBeenCalledWith('http://localhost:3456/api/roles/nightly-planner/enable', { method: 'POST', headers: { Authorization: 'Bearer tok' } });
    const out = logs.join('\n');
    expect(out).toContain('nightly-planner');
    expect(out).toMatch(/enabled/i);
  });

  test('roles disable <name> POSTs and prints the updated entry', async () => {
    const rolesFetch = vi.fn().mockResolvedValue(jsonResponse(200, {
      def: { name: 'nightly-planner', project: 'dispatch', global: false, agentType: 'planner', schedule: {}, authority: 'observe', wallClockCapMin: 45 },
      enabled: false,
      nextRunAt: null,
    }));
    const { logs, restore } = logged();

    await runCommand(['roles', 'disable', 'nightly-planner'], { port: 3456, rolesFetch, readOwnerToken: () => 'tok', processEnv: {} } as any);
    restore();

    expect(rolesFetch).toHaveBeenCalledWith('http://localhost:3456/api/roles/nightly-planner/disable', { method: 'POST', headers: { Authorization: 'Bearer tok' } });
    const out = logs.join('\n');
    expect(out).toContain('nightly-planner');
    expect(out).toMatch(/disabled/i);
  });

  test('roles enable on an unknown role surfaces the 404 error message', async () => {
    const rolesFetch = vi.fn().mockResolvedValue(jsonResponse(404, { error: 'role "ghost" not found' }));

    await expect(runCommand(['roles', 'enable', 'ghost'], { port: 3456, rolesFetch } as any))
      .rejects.toThrow('role "ghost" not found');
  });

  test('unknown roles subcommand throws a usage error', async () => {
    await expect(runCommand(['roles', 'bogus'], { port: 3456 } as any)).rejects.toThrow(/usage/i);
  });

  test('roles list with the daemon down reports a clear "daemon not running" error', async () => {
    const econnrefused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const rolesFetch = vi.fn().mockRejectedValue(econnrefused);

    await expect(runCommand(['roles', 'list'], { port: 3456, rolesFetch } as any))
      .rejects.toThrow(/daemon not running \(dispatch start\)/i);
  });
});
