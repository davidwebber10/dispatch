import { describe, test, expect, vi } from 'vitest';
import { createWslDaemon } from '../../src/platform/daemon-wsl.js';

function harness(files: Record<string, string> = {}, envOverrides: NodeJS.ProcessEnv = {}) {
  const calls: string[][] = [];
  const spawned: string[][] = [];
  const spawnedEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
  const killed: number[] = [];
  const daemon = createWslDaemon({
    dataDir: () => '/fake/.dispatch',
    execFileSync: (cmd, args) => { calls.push([cmd, ...args]); return ''; },
    readFile: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    writeFile: (p, s) => { files[p] = s; },
    unlink: (p) => { if (!(p in files)) throw new Error('ENOENT'); delete files[p]; },
    spawnDetached: (cmd, args, o) => { spawned.push([cmd, ...args]); spawnedEnvs.push(o?.env); },
    kill: (pid, sig) => {
      if (sig === 0 && killed.includes(pid)) throw new Error('ESRCH');
      if (sig !== 0) killed.push(pid);
    },
    env: { WSL_DISTRO_NAME: 'Ubuntu', ...envOverrides } as NodeJS.ProcessEnv,
  });
  return { daemon, calls, spawned, spawnedEnvs, killed, files };
}

const OPTS = { port: 3456, nodePath: '/usr/bin/node', entry: '/repo/packages/core/dist/server.js', repoRoot: '/repo', env: {}, logDir: '/fake/logs' };

// Matches the real /proc/<pid>/cmdline format: NUL-separated argv, produced by the daemon entry.
const OWN_CMDLINE = '/usr/bin/node\0/repo/packages/core/dist/server.js\0';
const OTHER_CMDLINE = 'nginx\0-g\0daemon off;\0';

test('install registers an ONLOGON schtask running wsl.exe --exec and persists daemon.json', () => {
  const { daemon, calls, files } = harness();
  daemon.install(OPTS);
  expect(calls[0][0]).toBe('schtasks.exe');
  expect(calls[0]).toContain('/SC');
  expect(calls[0]).toContain('ONLOGON');
  const tr = calls[0][calls[0].indexOf('/TR') + 1];
  expect(tr).toContain('wsl.exe -d "Ubuntu" --exec "/repo/bin/dispatch" daemon-run');
  expect(JSON.parse(files['/fake/.dispatch/daemon.json']).entry).toBe(OPTS.entry);
});

test('uninstall deletes the task', () => {
  const { daemon, calls } = harness();
  daemon.uninstall();
  expect(calls[0]).toEqual(['schtasks.exe', '/Delete', '/F', '/TN', 'Dispatch']);
});

test('uninstall best-effort deletes daemon.json and daemon.pid', () => {
  const { daemon, files } = harness({
    '/fake/.dispatch/daemon.pid': '4242',
    '/fake/.dispatch/daemon.json': JSON.stringify(OPTS),
  });
  daemon.uninstall();
  expect(files['/fake/.dispatch/daemon.json']).toBeUndefined();
  expect(files['/fake/.dispatch/daemon.pid']).toBeUndefined();
});

test('uninstall does not throw when state files are already absent', () => {
  const { daemon } = harness();
  expect(() => daemon.uninstall()).not.toThrow();
});

test('restart kills the recorded pid then respawns from daemon.json', () => {
  const { daemon, spawned, killed } = harness({
    '/fake/.dispatch/daemon.pid': '4242',
    '/fake/.dispatch/daemon.json': JSON.stringify(OPTS),
    '/proc/4242/cmdline': OWN_CMDLINE,
  });
  daemon.restart();
  expect(killed).toContain(4242);
  expect(spawned[0]).toEqual(['/usr/bin/node', '/repo/packages/core/dist/server.js']);
});

test('restart spawns with ambient env overlaid by baked install env, and PORT from persisted opts always wins', () => {
  const { daemon, spawnedEnvs } = harness(
    {
      '/fake/.dispatch/daemon.pid': '4242',
      '/fake/.dispatch/daemon.json': JSON.stringify({ ...OPTS, env: { FOO: 'from-install' } }),
      '/proc/4242/cmdline': OWN_CMDLINE,
    },
    { FOO: 'from-ambient', PORT: '9999' },
  );
  daemon.restart();
  expect(spawnedEnvs[0]?.FOO).toBe('from-install');
  expect(spawnedEnvs[0]?.PORT).toBe('3456');
  expect(spawnedEnvs[0]?.WSL_DISTRO_NAME).toBe('Ubuntu');
});

test('restart does not kill an unverified (possibly recycled) pid, but still spawns a fresh instance', () => {
  const { daemon, spawned, killed } = harness({
    '/fake/.dispatch/daemon.pid': '4242',
    '/fake/.dispatch/daemon.json': JSON.stringify(OPTS),
    '/proc/4242/cmdline': OTHER_CMDLINE,
  });
  daemon.restart();
  expect(killed).not.toContain(4242);
  expect(spawned[0]).toEqual(['/usr/bin/node', '/repo/packages/core/dist/server.js']);
});

test('restart throws instead of spawning a second instance when a verified-ours pid refuses to die', () => {
  const files: Record<string, string> = {
    '/fake/.dispatch/daemon.pid': '4242',
    '/fake/.dispatch/daemon.json': JSON.stringify(OPTS),
    '/proc/4242/cmdline': OWN_CMDLINE,
  };
  const spawned: string[][] = [];
  const daemon = createWslDaemon({
    dataDir: () => '/fake/.dispatch',
    execFileSync: () => '',
    readFile: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    writeFile: (p, s) => { files[p] = s; },
    unlink: (p) => { delete files[p]; },
    spawnDetached: (cmd, args) => { spawned.push([cmd, ...args]); },
    // Never throws on a liveness probe (sig 0) or a term signal: the pid looks alive forever.
    kill: () => {},
    env: { WSL_DISTRO_NAME: 'Ubuntu' } as NodeJS.ProcessEnv,
  });
  expect(() => daemon.restart()).toThrow(/previous daemon \(pid 4242\) did not exit within 5s/);
  expect(spawned).toHaveLength(0);
}, 7000);

test('stop kills the recorded pid when its cmdline matches the daemon entry', () => {
  const { daemon, killed } = harness({
    '/fake/.dispatch/daemon.pid': '4242',
    '/fake/.dispatch/daemon.json': JSON.stringify(OPTS),
    '/proc/4242/cmdline': OWN_CMDLINE,
  });
  daemon.stop();
  expect(killed).toContain(4242);
});

test('stop does not kill when the recorded pid belongs to another program (recycled pid)', () => {
  const { daemon, killed } = harness({
    '/fake/.dispatch/daemon.pid': '4242',
    '/fake/.dispatch/daemon.json': JSON.stringify(OPTS),
    '/proc/4242/cmdline': OTHER_CMDLINE,
  });
  daemon.stop();
  expect(killed).not.toContain(4242);
});

test('status reads the pidfile and probes liveness', () => {
  const { daemon } = harness({ '/fake/.dispatch/daemon.pid': '4242' });
  expect(daemon.status()).toEqual({ loaded: true, pid: 4242 });
});
