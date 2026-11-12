import { describe, test, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { forceIdentityArgs, installSpawnGuardOn, scrubEnv, scrubEnvPairs } from '../../src/privsep/spawn-guard.js';

const cfg = { agentUid: 1000, agentGid: 1000 };

/** A stand-in for the `child_process` module: it records what each entry point is finally given. */
function fakeChildProcess() {
  const seen: Array<{ via: string; options: any; args: unknown[] }> = [];
  class ChildProcess extends EventEmitter {
    spawn(options: any) { seen.push({ via: 'proto.spawn', options, args: [] }); return 0; }
  }
  const cp: any = {
    ChildProcess,
    spawn(file: string, args: string[], options: any) { const c = new ChildProcess(); c.spawn({ ...options, file, args, envPairs: Object.entries(options?.env ?? {}).map(([k, v]) => `${k}=${v}`) }); return c; },
    spawnSync(...args: unknown[]) { seen.push({ via: 'spawnSync', options: args[args.length - 1], args }); return {}; },
    execFileSync(...args: unknown[]) { seen.push({ via: 'execFileSync', options: args[args.length - 1], args }); return ''; },
    execSync(...args: unknown[]) { seen.push({ via: 'execSync', options: args[args.length - 1], args }); return ''; },
  };
  return { cp, seen };
}

describe('the spawn guard', () => {
  test('every asynchronous child is given the agent identity, whatever the caller asked for', () => {
    const { cp, seen } = fakeChildProcess();
    installSpawnGuardOn(cfg, { cp });
    cp.spawn('git', ['status'], { uid: 0, gid: 0, env: { PATH: '/usr/bin', OS_BOX_TOKEN: 'secret', DISPATCH_BOX_TOKEN: 'secret2' } });
    expect(seen).toHaveLength(1);
    expect(seen[0].options.uid).toBe(1000);
    expect(seen[0].options.gid).toBe(1000);
    expect(seen[0].options.envPairs).toEqual(['PATH=/usr/bin']);
  });

  test('a caller that holds an old reference to the module function is still covered (the prototype is patched)', () => {
    const { cp, seen } = fakeChildProcess();
    const early = cp.spawn; // imported before the guard was installed
    installSpawnGuardOn(cfg, { cp });
    early('id', [], {});
    expect(seen[0].options.uid).toBe(1000);
  });

  test('the three synchronous entry points', () => {
    const { cp, seen } = fakeChildProcess();
    installSpawnGuardOn(cfg, { cp });
    cp.spawnSync('ps', ['-e']);
    cp.execFileSync('git', ['rev-parse'], { cwd: '/x', uid: 0 });
    cp.execSync('id -u');
    cp.spawnSync('ls', { env: { A: '1', OS_BOX_TOKEN: 's' } });
    expect(seen.map((s) => [s.via, s.options.uid, s.options.gid])).toEqual([
      ['spawnSync', 1000, 1000], ['execFileSync', 1000, 1000], ['execSync', 1000, 1000], ['spawnSync', 1000, 1000],
    ]);
    expect(seen[1].options.cwd).toBe('/x');
    expect(seen[3].options.env).toEqual({ A: '1' });
  });

  test('installing twice does not wrap twice', () => {
    const { cp, seen } = fakeChildProcess();
    let synced = 0;
    installSpawnGuardOn(cfg, { cp, sync: () => { synced++; } });
    const once = cp.spawnSync;
    installSpawnGuardOn(cfg, { cp, sync: () => { synced++; } });
    expect(cp.spawnSync).toBe(once);
    expect(synced).toBe(1);
    cp.spawnSync('true');
    expect(seen).toHaveLength(1);
  });

  test('a terminal: agent identity, scrubbed environment, and the slave device given to the agent', () => {
    const { cp } = fakeChildProcess();
    const calls: any[] = [];
    const chowned: any[] = [];
    const pty = { spawn(file: unknown, args: unknown, options: unknown) { calls.push({ file, args, options }); return { _pty: '/dev/pts/7' }; } };
    installSpawnGuardOn(cfg, { cp, pty, chown: (p, u, g) => chowned.push([p, u, g]) });
    pty.spawn('/bin/bash', [], { cwd: '/home/p', uid: 0, env: { TERM: 'xterm', DISPATCH_BOX_TOKEN: 's' } });
    expect(calls[0].options).toMatchObject({ uid: 1000, gid: 1000, cwd: '/home/p', env: { TERM: 'xterm' } });
    expect(chowned).toEqual([['/dev/pts/7', 1000, 1000]]);
  });

  test('argument shapes of the synchronous calls', () => {
    expect(forceIdentityArgs(['id'], cfg)).toEqual(['id', { uid: 1000, gid: 1000 }]);
    expect(forceIdentityArgs(['id', ['-u']], cfg)).toEqual(['id', ['-u'], { uid: 1000, gid: 1000 }]);
    expect(forceIdentityArgs(['id', undefined, { cwd: '/' }], cfg)).toEqual(['id', undefined, { cwd: '/', uid: 1000, gid: 1000 }]);
    expect(forceIdentityArgs(['id -u', { uid: 0, gid: 0, shell: '/bin/sh' }], cfg)).toEqual(['id -u', { shell: '/bin/sh', uid: 1000, gid: 1000 }]);
  });

  test('the variables no child may see', () => {
    expect(scrubEnvPairs(['A=1', 'OS_BOX_TOKEN=x', 'DISPATCH_BOX_TOKEN=y', 'DISPATCH_SECRETS_FD=3', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/v2/c', 'ECS_CONTAINER_METADATA_URI_V4=http://m', 'OS_BOX_TOKENX=kept'])).toEqual(['A=1', 'OS_BOX_TOKENX=kept']);
    expect(scrubEnv({ A: '1', OS_BOX_TOKEN: 'x', ECS_AGENT_URI: 'u' })).toEqual({ A: '1' });
  });
});
