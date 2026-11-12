// packages/core/src/privsep/spawn-guard.ts
// The one chokepoint that makes every child process a workload (design section 4).
//
// On a box with privilege separation the daemon is root. A child inherits the parent's user unless
// the spawn says otherwise, and the daemon has about forty spawn sites, so "remember the option at
// each site" would fail open. Instead the process-creation entry points themselves are replaced,
// once, before any other module runs:
//
//   ChildProcess.prototype.spawn   used by spawn, exec, execFile and fork
//   spawnSync, execFileSync, execSync
//   the PTY library's spawn
//
// Each call is given the agent's uid and gid (the caller cannot choose another), and the variables
// in NEVER_INHERITED are removed from its environment. In the forked child the runtime calls
// setgroups(0), setgid and setuid before exec; the kernel then clears every capability. There is
// no way to ask for a child that runs as the daemon user.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { PrivsepConfig } from './config.js';
import { NEVER_INHERITED } from './secrets.js';

const never = new Set<string>(NEVER_INHERITED);

/** An `envPairs` array ("NAME=value") without the variables no child may see. */
export function scrubEnvPairs(pairs: readonly string[]): string[] {
  return pairs.filter((p) => { const i = p.indexOf('='); return !never.has(i < 0 ? p : p.slice(0, i)); });
}

/** An environment object without the variables no child may see. */
export function scrubEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  for (const name of never) delete out[name];
  return out;
}

const isOptions = (a: unknown): a is Record<string, unknown> =>
  a !== null && typeof a === 'object' && !Array.isArray(a);

/**
 * The argument list of a synchronous spawn with the identity forced into its options object
 * (`file[, args][, options]` and `command[, options]` both end with the options).
 */
export function forceIdentityArgs(args: readonly unknown[], cfg: Pick<PrivsepConfig, 'agentUid' | 'agentGid'>): unknown[] {
  const out = [...args];
  let at = -1;
  for (let i = 1; i < out.length; i++) if (isOptions(out[i])) { at = i; break; }
  const base = at >= 0 ? (out[at] as Record<string, unknown>) : {};
  const next: Record<string, unknown> = { ...base, uid: cfg.agentUid, gid: cfg.agentGid };
  if (isOptions(base.env)) next.env = scrubEnv(base.env as Record<string, string | undefined>);
  if (at >= 0) out[at] = next; else out.push(next);
  return out;
}

export interface GuardTargets {
  /** The `child_process` module object (its exports are replaced in place). */
  cp: typeof childProcess;
  /** The PTY module object, when the library is present. */
  pty?: { spawn: (...a: any[]) => any } | null;
  /** Called after the exports changed, so ESM importers see them. */
  sync?: () => void;
  chown?: (p: string, uid: number, gid: number) => void;
}

const INSTALLED = Symbol.for('dispatch.privsep.spawnGuard');

/** Replace the entry points on the given module objects. Idempotent per module object. */
export function installSpawnGuardOn(cfg: Pick<PrivsepConfig, 'agentUid' | 'agentGid'>, t: GuardTargets): void {
  const cp = t.cp as typeof childProcess & { [INSTALLED]?: true };
  if (!cp[INSTALLED]) {
    const proto = cp.ChildProcess.prototype as unknown as { spawn: (options: Record<string, unknown>) => unknown };
    const original = proto.spawn;
    proto.spawn = function guardedSpawn(this: unknown, options: Record<string, unknown>) {
      const o = isOptions(options) ? options : {};
      o.uid = cfg.agentUid;
      o.gid = cfg.agentGid;
      if (Array.isArray(o.envPairs)) o.envPairs = scrubEnvPairs(o.envPairs as string[]);
      return original.call(this, o);
    };
    for (const name of ['spawnSync', 'execFileSync', 'execSync'] as const) {
      const fn = cp[name] as (...a: unknown[]) => unknown;
      (cp as unknown as Record<string, unknown>)[name] = function guardedSync(this: unknown, ...args: unknown[]) {
        return fn.apply(this, forceIdentityArgs(args, cfg));
      };
    }
    cp[INSTALLED] = true;
    t.sync?.();
  }
  const pty = t.pty as ({ spawn: (...a: any[]) => any } & { [INSTALLED]?: true }) | null | undefined;
  if (pty && !pty[INSTALLED]) {
    const spawnPty = pty.spawn;
    const chown = t.chown ?? ((p, uid, gid) => fs.chownSync(p, uid, gid));
    pty.spawn = function guardedPty(file: unknown, args: unknown, options: unknown) {
      const base = isOptions(options) ? options : {};
      const next: Record<string, unknown> = { ...base, uid: cfg.agentUid, gid: cfg.agentGid };
      if (isOptions(base.env)) next.env = scrubEnv(base.env as Record<string, string | undefined>);
      const term = spawnPty.call(pty, file, args, next);
      // The slave device belongs to whoever opened it (the daemon). Programs that reopen their
      // terminal by path need it to be the agent's.
      const slave = (term as { _pty?: unknown })._pty;
      if (typeof slave === 'string' && slave.startsWith('/dev/')) { try { chown(slave, cfg.agentUid, cfg.agentGid); } catch { /* the PTY still works through its open descriptors */ } }
      return term;
    };
    pty[INSTALLED] = true;
  }
}

/** Install on the real modules of this process. */
export function installSpawnGuard(cfg: PrivsepConfig): void {
  const require = createRequire(import.meta.url);
  let pty: { spawn: (...a: any[]) => any } | null = null;
  try { pty = require('node-pty'); } catch { pty = null; }
  installSpawnGuardOn(cfg, { cp: require('node:child_process'), pty, sync: syncBuiltinESMExports });
}

export interface GuardCheck { via: string; uid: string }

/**
 * Start `id -u` through every entry point and return what each child answered. The daemon refuses
 * to start unless every answer is the agent uid.
 */
export async function probeSpawnGuard(): Promise<GuardCheck[]> {
  const cp = await import('node:child_process');
  const out: GuardCheck[] = [];
  const text = (b: unknown) => String(b ?? '').trim();
  out.push({ via: 'spawnSync', uid: text(cp.spawnSync('id', ['-u']).stdout) });
  out.push({ via: 'execFileSync', uid: text(cp.execFileSync('id', ['-u'])) });
  out.push({ via: 'execSync', uid: text(cp.execSync('id -u')) });
  out.push({ via: 'spawn', uid: await new Promise<string>((resolve) => {
    let s = ''; const c = cp.spawn('id', ['-u']); c.stdout.on('data', (d) => { s += d; }); c.on('error', () => resolve('error')); c.on('close', () => resolve(s.trim()));
  }) });
  out.push({ via: 'execFile', uid: await new Promise<string>((resolve) => { cp.execFile('id', ['-u'], (err, stdout) => resolve(err ? 'error' : text(stdout))); }) });
  out.push({ via: 'exec', uid: await new Promise<string>((resolve) => { cp.exec('id -u', (err, stdout) => resolve(err ? 'error' : text(stdout))); }) });
  out.push({ via: 'fork', uid: await new Promise<string>((resolve) => {
    let s = '';
    const c = cp.fork('-e', [], { execArgv: ['-e', 'process.stdout.write(String(process.getuid()))'], silent: true });
    c.stdout?.on('data', (d) => { s += d; }); c.on('error', () => resolve('error')); c.on('close', () => resolve(s.trim()));
  }) });
  try {
    const pty = await import('node-pty');
    out.push({ via: 'pty', uid: await new Promise<string>((resolve) => {
      let s = '';
      const t = pty.spawn('id', ['-u'], { cwd: '/', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
      t.onData((d) => { s += d; }); t.onExit(() => resolve(s.trim()));
    }) });
  } catch { out.push({ via: 'pty', uid: 'unavailable' }); }
  return out;
}
