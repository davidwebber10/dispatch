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

test('install registers an ONLOGON schtask running wsl.exe --exec (UNQUOTED) and persists daemon.json', () => {
  const { daemon, calls, files } = harness();
  daemon.install(OPTS);
  expect(calls[0][0]).toBe('schtasks.exe');
  expect(calls[0]).toContain('/SC');
  expect(calls[0]).toContain('ONLOGON');
  const tr = calls[0][calls[0].indexOf('/TR') + 1];
  // Absolute node + absolute CLI entry, no PATH dependency (nvm-installed node isn't on
  // the ONLOGON task's non-login PATH, so the bin/dispatch sh shim's bare `exec node`
  // fails silently at logon otherwise). UNQUOTED: wsl.exe's --exec does naive whitespace
  // splitting on the TR string and does not understand shell quoting, so a quoted
  // "/usr/bin/node" is exec'd literally (quotes included) and fails with ENOENT — verified
  // live on Tier-3 hardware (Last Result -1). The unquoted form was verified working live.
  expect(tr).toContain('wsl.exe -d Ubuntu --exec /usr/bin/node /repo/packages/cli/dist/index.js daemon-run');
  expect(tr).not.toContain('"');
  expect(JSON.parse(files['/fake/.dispatch/daemon.json']).entry).toBe(OPTS.entry);
});

test('install throws before creating anything when repoRoot contains a space (unquoted TR breaks on spaces)', () => {
  const { daemon, calls, files } = harness();
  const spacedOpts = { ...OPTS, repoRoot: '/repo with space' };
  expect(() => daemon.install(spacedOpts)).toThrow(/space/i);
  expect(calls).toHaveLength(0); // schtasks.exe never invoked
  expect(files['/fake/.dispatch/daemon.json']).toBeUndefined(); // daemon.json never written
});

test('install throws an actionable error (with the exact manual schtasks.exe command) when /Create fails', () => {
  const failing = createWslDaemon({
    dataDir: () => '/fake/.dispatch',
    execFileSync: (cmd, args) => {
      if (cmd === 'schtasks.exe' && args[0] === '/Create') throw new Error('Access is denied.');
      return '';
    },
    readFile: () => { throw new Error('ENOENT'); },
    writeFile: () => {},
    unlink: () => {},
    spawnDetached: () => {},
    kill: () => {},
    env: { WSL_DISTRO_NAME: 'Ubuntu' } as NodeJS.ProcessEnv,
  });
  expect(() => failing.install(OPTS)).toThrow(/schtasks\.exe \/Create/);
  expect(() => failing.install(OPTS)).toThrow(/dispatch run/);
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

test('restart throws instead of spawning a second instance when a verified-ours pid refuses to die (even after the final re-check)', () => {
  const files: Record<string, string> = {
    '/fake/.dispatch/daemon.pid': '4242',
    '/fake/.dispatch/daemon.json': JSON.stringify(OPTS),
    '/proc/4242/cmdline': OWN_CMDLINE,
  };
  const spawned: string[][] = [];
  const WAIT_ITERATIONS = 3; // keep real-time cost down (real Atomics.wait sleeps 100ms/iter)
  const daemon = createWslDaemon({
    dataDir: () => '/fake/.dispatch',
    execFileSync: () => '',
    readFile: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    writeFile: (p, s) => { files[p] = s; },
    unlink: (p) => { delete files[p]; },
    spawnDetached: (cmd, args) => { spawned.push([cmd, ...args]); },
    // Never throws on a liveness probe (sig 0) or a term signal: the pid looks alive forever,
    // including on the final post-loop re-check.
    kill: () => {},
    waitIterations: WAIT_ITERATIONS,
    env: { WSL_DISTRO_NAME: 'Ubuntu' } as NodeJS.ProcessEnv,
  });
  expect(() => daemon.restart()).toThrow(
    new RegExp(`previous daemon \\(pid 4242\\) did not exit within ${WAIT_ITERATIONS / 10}s`),
  );
  expect(spawned).toHaveLength(0);
});

test('restart proceeds to spawn (no throw) when the pid dies late — alive during the wait loop, dead on the final re-check', () => {
  const files: Record<string, string> = {
    '/fake/.dispatch/daemon.pid': '4242',
    '/fake/.dispatch/daemon.json': JSON.stringify(OPTS),
    '/proc/4242/cmdline': OWN_CMDLINE,
  };
  const spawned: string[][] = [];
  const WAIT_ITERATIONS = 3;
  let aliveChecks = 0;
  const daemon = createWslDaemon({
    dataDir: () => '/fake/.dispatch',
    execFileSync: () => '',
    readFile: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    writeFile: (p, s) => { files[p] = s; },
    unlink: (p) => { delete files[p]; },
    spawnDetached: (cmd, args) => { spawned.push([cmd, ...args]); },
    kill: (pid, sig) => {
      if (sig !== 0) return; // SIGTERM: accept, no-op
      aliveChecks++;
      // Alive for every liveness probe during the wait loop (the first WAIT_ITERATIONS
      // calls), but dead on the (WAIT_ITERATIONS + 1)th — the one final re-check performed
      // after the loop exhausts its budget.
      if (aliveChecks > WAIT_ITERATIONS) throw new Error('ESRCH');
    },
    waitIterations: WAIT_ITERATIONS,
    env: { WSL_DISTRO_NAME: 'Ubuntu' } as NodeJS.ProcessEnv,
  });
  expect(() => daemon.restart()).not.toThrow();
  expect(spawned[0]).toEqual(['/usr/bin/node', '/repo/packages/core/dist/server.js']);
  expect(aliveChecks).toBe(WAIT_ITERATIONS + 1);
});

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
