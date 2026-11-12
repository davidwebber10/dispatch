import fs from 'node:fs';
import path from 'node:path';
import { toolPaths, hostOsFamily } from './paths.js';
import { isHostedBox } from '../os/hosted-mode.js';
import { loadManifest } from './manifest.js';
import type { ToolStatus, ToolAuthState, AuthCheckOutcome } from './types.js';
export { getToolsSpawnEnv } from './spawnEnv.js';
export { awarenessNote } from './awareness.js';

/**
 * `env` should be the env a thread spawns with (ToolAuthProber.threadEnv), and `checks` the
 * prober's cached authCheck outcomes. A check that answered decides: it ran WITH that env, so
 * an expired token in it is still 'needed'. With no answer ('unknown', or not run yet), a
 * satisfied env rule is 'ok'; otherwise a tool with a check is 'unknown' — a timeout is not
 * proof of a missing sign-in — and one without a check keeps the old 'needed'.
 */
/** True when `bin` is an executable file in one of the PATH folders. */
export function onPath(bin: string, pathVar: string | undefined): boolean {
  for (const dir of (pathVar ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

export function toolStatuses(opts?: { base?: string; env?: Record<string, string | undefined>; checks?: Record<string, AuthCheckOutcome> }): ToolStatus[] {
  const env = opts?.env ?? process.env;
  const p = toolPaths(opts?.base);
  const family = hostOsFamily();
  const hosted = isHostedBox();
  return loadManifest(opts?.base)
    .filter((e) => !e.platforms || e.platforms.includes(family))
    .map((e) => {
      // A hosted box ships some tools in its image (ripgrep in /usr/bin): there, a tool on the threads'
      // PATH counts as installed too (box defect #12). A local install keeps the managed-folder check.
      const installed = e.bins.every((b) => fs.existsSync(path.join(p.bin, b)) || (hosted && onPath(b, env.PATH)));
      const envAuthed = !e.authEnv?.length ? true : e.authEnv.every((k) => !!(env[k] || (e.envAlias && Object.entries(e.envAlias).some(([w, s]) => w === k && env[s]))));
      const checked = e.authCheck ? opts?.checks?.[e.name] : undefined;
      const authState: ToolAuthState = checked === 'ok' ? 'ok' : checked === 'failed' ? 'needed'
        : envAuthed ? 'ok' : e.authCheck ? 'unknown' : 'needed';
      return { name: e.name, description: e.description, kind: e.kind, installed, authed: authState === 'ok', authState, docs: e.docs };
    });
}
