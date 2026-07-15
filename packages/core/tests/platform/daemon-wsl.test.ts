import { describe, test, expect, vi } from 'vitest';
import { createWslDaemon } from '../../src/platform/daemon-wsl.js';

function harness(files: Record<string, string> = {}) {
  const calls: string[][] = [];
  const spawned: string[][] = [];
  const killed: number[] = [];
  const daemon = createWslDaemon({
    dataDir: () => '/fake/.dispatch',
    execFileSync: (cmd, args) => { calls.push([cmd, ...args]); return ''; },
    readFile: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    writeFile: (p, s) => { files[p] = s; },
    unlink: (p) => { delete files[p]; },
    spawnDetached: (cmd, args) => { spawned.push([cmd, ...args]); },
    kill: (pid, sig) => {
      if (sig === 0 && killed.includes(pid)) throw new Error('ESRCH');
      if (sig !== 0) killed.push(pid);
    },
    env: { WSL_DISTRO_NAME: 'Ubuntu' } as NodeJS.ProcessEnv,
  });
  return { daemon, calls, spawned, killed, files };
}

const OPTS = { port: 3456, nodePath: '/usr/bin/node', entry: '/repo/packages/core/dist/server.js', repoRoot: '/repo', env: {}, logDir: '/fake/logs' };

test('install registers an ONLOGON schtask running wsl.exe --exec and persists daemon.json', () => {
  const { daemon, calls, files } = harness();
  daemon.install(OPTS);
  expect(calls[0][0]).toBe('schtasks.exe');
  expect(calls[0]).toContain('/SC');
  expect(calls[0]).toContain('ONLOGON');
  const tr = calls[0][calls[0].indexOf('/TR') + 1];
  expect(tr).toContain('wsl.exe -d Ubuntu --exec /repo/bin/dispatch daemon-run');
  expect(JSON.parse(files['/fake/.dispatch/daemon.json']).entry).toBe(OPTS.entry);
});
test('uninstall deletes the task', () => {
  const { daemon, calls } = harness();
  daemon.uninstall();
  expect(calls[0]).toEqual(['schtasks.exe', '/Delete', '/F', '/TN', 'Dispatch']);
});
test('restart kills the recorded pid then respawns from daemon.json', () => {
  const { daemon, spawned, killed, files } = harness({
    '/fake/.dispatch/daemon.pid': '4242',
    '/fake/.dispatch/daemon.json': JSON.stringify(OPTS),
  });
  daemon.restart();
  expect(killed).toContain(4242);
  expect(spawned[0]).toEqual(['/usr/bin/node', '/repo/packages/core/dist/server.js']);
});
test('status reads the pidfile and probes liveness', () => {
  const { daemon } = harness({ '/fake/.dispatch/daemon.pid': '4242' });
  expect(daemon.status()).toEqual({ loaded: true, pid: 4242 });
});
