// packages/core/src/privsep/paths.ts
// Where files go on a box with privilege separation (design section 7), and who may touch them.
//
//   state root      private to the daemon. `platform.dataDir()` returns it, so a path nobody moved
//                   is unreadable to a workload: it fails closed.
//   agent run dir   written by the daemon for a workload to READ (root-owned, group of the agent).
//   agent data dir  written by workloads and kept (below the person's home, owned by the agent).
//
// Without privilege separation every function here returns the old path under the data directory
// and changes no owner and no mode, so a local install behaves exactly as before.
import fs from 'node:fs';
import path from 'node:path';
import { privsep, type PrivsepConfig } from './config.js';

const SUB = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkSub(sub: string): void {
  if (!SUB.test(sub)) throw new Error(`not a plain folder name: ${sub}`);
}

/** Group read (and search, for a folder or an executable) for the agent's group; never write. */
function groupBits(mode: number): number {
  const owner = (mode >> 6) & 0o7;
  return (mode & 0o700) | ((owner & 0o5) << 3);
}

/**
 * Let workloads read one file or folder the daemon wrote: owner root, group of the agent, group
 * bits copied from the owner's read and execute bits, nothing for others. A symbolic link is refused.
 */
export function publishToAgent(target: string, cfg: PrivsepConfig | null = privsep()): void {
  if (!cfg) return;
  const st = fs.lstatSync(target);
  if (st.isSymbolicLink()) throw new Error(`refusing to publish a symbolic link: ${target}`);
  fs.chownSync(target, 0, cfg.agentGid);
  fs.chmodSync(target, groupBits(st.mode & 0o777));
}

/**
 * A folder below the agent run dir (root-owned, readable by the agent's group). Local: `<dataDir>/<sub>`.
 */
export function runDirFor(dataDir: string, sub: string, cfg: PrivsepConfig | null = privsep()): string {
  checkSub(sub);
  if (!cfg) return path.join(dataDir, sub);
  const dir = path.join(cfg.agentRunDir, sub);
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  fs.chownSync(dir, 0, cfg.agentGid);
  fs.chmodSync(dir, 0o750);
  return dir;
}

/**
 * A scratch folder on the box's own disk that workloads may write (sockets, lock files). Owned by
 * the agent. Nothing the daemon trusts is read from it. Local: `<dataDir>/<sub>`.
 */
export function scratchDirFor(dataDir: string, sub: string, cfg: PrivsepConfig | null = privsep()): string {
  checkSub(sub);
  if (!cfg) return path.join(dataDir, sub);
  const root = path.join(cfg.agentRunDir, 'rw');
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  const dir = path.join(root, sub);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.lchownSync(dir, cfg.agentUid, cfg.agentGid);
  return dir;
}

/** True when `child` is `parent` or below it (both resolved by the caller). */
export function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** The roots a workload must never be led into by a path from the home. */
export function privateRoots(cfg: PrivsepConfig | null = privsep()): string[] {
  if (!cfg) return [];
  return [path.dirname(cfg.stateDir), cfg.stateDir, cfg.agentRunDir];
}

/**
 * Refuse a path below the home whose real location is outside the home (a symbolic link planted by
 * a workload). The daemon calls this before it WRITES below the home with its own rights.
 * Returns the path unchanged. Without privilege separation it checks nothing.
 */
export function assertInHome(target: string, cfg: PrivsepConfig | null = privsep()): string {
  if (!cfg) return target;
  const home = fs.realpathSync(cfg.agentHome);
  // The deepest existing ancestor decides: a missing leaf cannot be a link yet.
  let probe = path.resolve(target);
  for (;;) {
    try { probe = fs.realpathSync(probe); break; } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
  }
  if (!isInside(probe, home)) throw new Error(`refusing a path that leaves the home: ${target}`);
  return target;
}

/**
 * Give one file, folder or link below the home to the agent user (never follows a link). The mount
 * of a hosted home enforces one user, so there this changes nothing and a refusal is ignored.
 */
export function giveToAgent(target: string, cfg: PrivsepConfig | null = privsep()): void {
  if (!cfg) return;
  try {
    const st = fs.lstatSync(target);
    if (st.uid === cfg.agentUid && st.gid === cfg.agentGid) return;
    fs.lchownSync(target, cfg.agentUid, cfg.agentGid);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'ENOENT' && code !== 'EINVAL') throw err;
  }
}

/** `giveToAgent` for a folder and everything in it. Links are given, not followed. */
export function giveTreeToAgent(root: string, cfg: PrivsepConfig | null = privsep()): void {
  if (!cfg) return;
  const walk = (p: string, depth: number) => {
    giveToAgent(p, cfg);
    let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch { return; }
    if (!st.isDirectory() || depth > 64) return;
    let names: string[] = [];
    try { names = fs.readdirSync(p); } catch { return; }
    for (const n of names) walk(path.join(p, n), depth + 1);
  };
  walk(root, 0);
}

/**
 * A folder below the agent data dir (`$HOME/.dispatch/<sub>`), owned by the agent: harness state a
 * workload writes and keeps. Local: `<dataDir>/<sub>`.
 */
export function agentDirFor(dataDir: string, sub: string, cfg: PrivsepConfig | null = privsep()): string {
  checkSub(sub);
  if (!cfg) return path.join(dataDir, sub);
  const dir = path.join(cfg.agentDataDir, sub);
  assertInHome(dir, cfg);
  fs.mkdirSync(cfg.agentDataDir, { recursive: true, mode: 0o700 });
  giveToAgent(cfg.agentDataDir, cfg);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  giveToAgent(dir, cfg);
  return dir;
}

/**
 * Make a folder for workloads (and its missing parents) and give each new one to the agent.
 * Local: a plain recursive mkdir.
 */
export function mkdirForAgent(dir: string, opts: { mode?: number; confine?: boolean } = {}, cfg: PrivsepConfig | null = privsep()): void {
  const mode = opts.mode ?? 0o777; // the process umask applies, as with a plain mkdir
  if (!cfg) { fs.mkdirSync(dir, { recursive: true, mode }); return; }
  // `confine: false`: the caller already confined the path (the file routes), or the folder is a
  // project the person placed outside the home.
  if (opts.confine !== false) assertInHome(dir, cfg);
  const missing: string[] = [];
  let p = path.resolve(dir);
  while (!fs.existsSync(p)) { missing.unshift(p); const up = path.dirname(p); if (up === p) break; p = up; }
  for (const m of missing) { fs.mkdirSync(m, { mode }); giveToAgent(m, cfg); }
}
