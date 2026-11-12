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
import { agentMkdir } from './agent-fs.js';

const SUB = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkSub(sub: string): void {
  if (!SUB.test(sub)) throw new Error(`not a plain folder name: ${sub}`);
}

/** The daemon's own user: root on a box (privsep/config.ts refuses anything else). */
const daemonUid = (): number => (typeof process.getuid === 'function' ? process.getuid() : 0);

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
  fs.chownSync(target, daemonUid(), cfg.agentGid);
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
  fs.chownSync(dir, daemonUid(), cfg.agentGid);
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
 * Give ONE FIXED PATH to the agent user at start: the home (a mount point below root-owned folders)
 * and the agent data dir in it. Never follows a link, and is called before any workload runs, so
 * nothing can be swapped under it. Everything else below the home is created AS the agent
 * (privsep/agent-fs.ts): the daemon never changes an owner there. The mount of a hosted home
 * enforces one user, so there this changes nothing and a refusal is ignored.
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

/**
 * Let workloads read a folder the daemon wrote in the agent run dir, with everything in it. A link
 * anywhere inside is refused.
 */
export function publishTreeToAgent(root: string, cfg: PrivsepConfig | null = privsep()): void {
  if (!cfg) return;
  const walk = (p: string, depth: number) => {
    publishToAgent(p, cfg);
    if (depth > 32 || !fs.lstatSync(p).isDirectory()) return;
    for (const n of fs.readdirSync(p)) walk(path.join(p, n), depth + 1);
  };
  walk(root, 0);
}

const madeAgentDirs = new Set<string>();

/**
 * A folder below the agent data dir (`$HOME/.dispatch/<sub>`), owned by the agent: harness state a
 * workload writes and keeps. Local: `<dataDir>/<sub>`.
 */
export function agentDirFor(dataDir: string, sub: string, cfg: PrivsepConfig | null = privsep()): string {
  checkSub(sub);
  if (!cfg) return path.join(dataDir, sub);
  const dir = path.join(cfg.agentDataDir, sub);
  // Made as the agent: a link planted at the data dir leads only where the agent could already go.
  // Once per start is enough (a workload that removes it later breaks only its own harness).
  if (!madeAgentDirs.has(dir)) { agentMkdir(dir, cfg); madeAgentDirs.add(dir); }
  return dir;
}
