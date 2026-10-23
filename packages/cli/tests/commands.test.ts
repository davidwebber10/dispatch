import { afterEach, describe, expect, test, vi } from 'vitest';
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
import { runCommand, lastLines, probeHttp, cmdBuild, cmdRun, cmdUpdate, latestReleaseTag } from '../src/index.js';

// Give both mocks a harmless default implementation so tests that don't care about
// child_process (routing, probe-via-injected-`probe`, etc.) keep behaving as if the
// real commands had succeeded quietly — matching the pre-mock behavior where these
// calls actually ran (and usually succeeded) against the real dev environment.
function resetChildProcessMocks(): void {
  vi.mocked(execFileSync).mockReset().mockImplementation((() => '') as any);
  vi.mocked(spawnSync).mockReset().mockImplementation((() => ({ status: 0, stdout: '', stderr: '' })) as any);
}
resetChildProcessMocks();

afterEach(() => {
  resetChildProcessMocks();
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

describe('cmdUpdate', () => {
  test('fast-forwards to the newest release tag, then builds, then daemon.restart() — in that order', () => {
    const calls: string[] = [];
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      calls.push(`${cmd} ${(args ?? []).join(' ')}`);
      if (cmd === 'git' && args[0] === 'ls-remote') return 'a\trefs/tags/v3.9.2\nb\trefs/tags/v3.10.0\nc\trefs/tags/v3.11.0-rc1\n';
      return Buffer.from('');
    }) as any);
    const daemon = {
      install: vi.fn(), uninstall: vi.fn(), start: vi.fn(), stop: vi.fn(),
      status: vi.fn(() => ({ loaded: true })),
      restart: vi.fn(() => { calls.push('daemon.restart'); }),
    };

    cmdUpdate({ daemon } as any);

    const pullIdx = calls.findIndex(c => c === 'git merge --ff-only refs/tags/v3.10.0');
    // The tip of main is never pulled.
    expect(calls.some(c => c.startsWith('git pull'))).toBe(false);
    expect(calls.findIndex(c => c === 'git fetch origin --tags')).toBeLessThan(pullIdx);
    const installIdx = calls.findIndex(c => c === 'pnpm install');
    const buildIdx = calls.findIndex(c => c === 'pnpm -r run build');
    const restartIdx = calls.findIndex(c => c === 'daemon.restart');

    expect(pullIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeGreaterThan(pullIdx);
    expect(buildIdx).toBeGreaterThan(installIdx);
    expect(restartIdx).toBeGreaterThan(buildIdx);
    expect(daemon.restart).toHaveBeenCalledOnce();
  });

  test('a restart() that throws (e.g. linux "not implemented") propagates rather than being swallowed', () => {
    const daemon = {
      install: vi.fn(), uninstall: vi.fn(), start: vi.fn(), stop: vi.fn(),
      status: vi.fn(() => ({ loaded: true })),
      restart: vi.fn(() => { throw new Error('restart: not implemented on linux'); }),
    };

    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => (cmd === 'git' && args[0] === 'ls-remote' ? 'a\trefs/tags/v1.0.0\n' : '')) as any);
    expect(() => cmdUpdate({ daemon } as any)).toThrow('restart: not implemented on linux');
  });
});

describe('cmdUpdate with no release tag', () => {
  test('fails at the pull step instead of pulling main', () => {
    const calls: string[] = [];
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => { calls.push(`${cmd} ${args.join(' ')}`); return ''; }) as any);
    const daemon = { restart: vi.fn() };
    expect(() => cmdUpdate({ daemon } as any)).toThrow(/No release tag/);
    expect(calls.some(c => c.startsWith('git pull') || c.startsWith('git merge'))).toBe(false);
    expect(daemon.restart).not.toHaveBeenCalled();
  });
});

describe('latestReleaseTag', () => {
  test('first plain vX.Y.Z, skipping prerelease shapes', () => {
    expect(latestReleaseTag('a\trefs/tags/v2.0.0-rc1\nb\trefs/tags/v1.9.0\nc\trefs/tags/v1.10.0')).toBe('v1.10.0');
    expect(latestReleaseTag('')).toBeNull();
  });
});

describe('cmdUpdate progress file', () => {
  const daemonWith = (restart: () => void = () => {}) => ({
    install: vi.fn(), uninstall: vi.fn(), start: vi.fn(), stop: vi.fn(),
    status: vi.fn(() => ({ loaded: true })), restart: vi.fn(restart),
  });
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-upd-'));
  const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'update-status.json'), 'utf8'));

  test('records each step in order and ends "restarting" just before the restart', () => {
    const dataDir = tmp();
    const seen: string[] = [];
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return '';
      if (cmd === 'git' && args[0] === 'ls-remote') return 'a\trefs/tags/v1.0.0\n';
      if (cmd === 'git' && args[0] === 'fetch') return '';
      seen.push(`${read(dataDir).step}:${cmd} ${args[0]}`);
      return '';
    }) as any);
    const daemon = daemonWith(() => { seen.push(`${read(dataDir).state}:restart`); });
    cmdUpdate({ daemon, dataDir, repoRoot: dataDir } as any);
    expect(seen.map((x) => x.split(':')[0] + ':' + (x.includes(process.execPath) ? 'node' : x.split(':').slice(1).join(':')))).toEqual(
      ['pull:git merge', 'install:pnpm install', 'build:pnpm -r', 'tools:node', 'restarting:restart']);
    const s = read(dataDir);
    expect(s).toMatchObject({ v: 1, state: 'restarting', step: 'restart', steps: ['pull', 'install', 'build', 'tools', 'restart'], error: null });
    expect(typeof s.pid).toBe('number');
    expect(typeof s.startedAt).toBe('string');
  });

  test('a failed step is recorded with its step and message, and the error still propagates', () => {
    const dataDir = tmp();
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'pnpm' && args[0] === '-r') throw new Error('Command failed: pnpm -r run build');
      if (cmd === 'git' && args[0] === 'ls-remote') return 'a\trefs/tags/v1.0.0\n';
      return '';
    }) as any);
    expect(() => cmdUpdate({ daemon: daemonWith(), dataDir, repoRoot: dataDir } as any)).toThrow('pnpm -r run build');
    expect(read(dataDir)).toMatchObject({ state: 'failed', step: 'build', error: 'Command failed: pnpm -r run build' });
  });

  test('skips pnpm install when the lockfile did not change and node_modules exists', () => {
    const repoRoot = tmp();
    fs.mkdirSync(path.join(repoRoot, 'node_modules'));
    const calls: string[] = [];
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'git' && args[0] === 'rev-parse') return 'abc123\n';
      if (cmd === 'git' && args[0] === 'ls-remote') return 'a\trefs/tags/v1.0.0\n';
      return '';
    }) as any);
    cmdUpdate({ daemon: daemonWith(), dataDir: repoRoot, repoRoot } as any);
    expect(calls).not.toContain('pnpm install');
    expect(read(repoRoot).skipped).toEqual(['install']);
  });

  test('runs pnpm install when the lockfile changed', () => {
    const repoRoot = tmp();
    fs.mkdirSync(path.join(repoRoot, 'node_modules'));
    let n = 0;
    const calls: string[] = [];
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'git' && args[0] === 'rev-parse') return `hash${++n}\n`;
      if (cmd === 'git' && args[0] === 'ls-remote') return 'a\trefs/tags/v1.0.0\n';
      return '';
    }) as any);
    cmdUpdate({ daemon: daemonWith(), dataDir: repoRoot, repoRoot } as any);
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

    await runCommand(['roles', 'list'], { port: 3456, rolesFetch } as any);
    restore();

    expect(rolesFetch).toHaveBeenCalledWith('http://localhost:3456/api/roles', undefined);
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

    await runCommand(['roles', 'enable', 'nightly-planner'], { port: 3456, rolesFetch } as any);
    restore();

    expect(rolesFetch).toHaveBeenCalledWith('http://localhost:3456/api/roles/nightly-planner/enable', { method: 'POST' });
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

    await runCommand(['roles', 'disable', 'nightly-planner'], { port: 3456, rolesFetch } as any);
    restore();

    expect(rolesFetch).toHaveBeenCalledWith('http://localhost:3456/api/roles/nightly-planner/disable', { method: 'POST' });
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
