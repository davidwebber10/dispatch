import fs from 'node:fs';
import path from 'node:path';
import { toolPaths, hostOsFamily } from './paths.js';
import { loadManifest } from './manifest.js';
import type { ToolStatus, AuthCheckOutcome } from './types.js';
export { getToolsSpawnEnv } from './spawnEnv.js';
export { awarenessNote } from './awareness.js';

/**
 * `env` should be the env a thread spawns with (ToolAuthProber.threadEnv), and `checks` the
 * prober's cached authCheck outcomes. A check that answered decides: it ran WITH that env, so
 * an expired token in it is still "not authed". With no answer ('unknown', or not run yet),
 * the env rule decides.
 */
export function toolStatuses(opts?: { base?: string; env?: Record<string, string | undefined>; checks?: Record<string, AuthCheckOutcome> }): ToolStatus[] {
  const env = opts?.env ?? process.env;
  const p = toolPaths(opts?.base);
  const family = hostOsFamily();
  return loadManifest(opts?.base)
    .filter((e) => !e.platforms || e.platforms.includes(family))
    .map((e) => {
      const installed = e.bins.every((b) => fs.existsSync(path.join(p.bin, b)));
      const envAuthed = !e.authEnv?.length ? true : e.authEnv.every((k) => !!(env[k] || (e.envAlias && Object.entries(e.envAlias).some(([w, s]) => w === k && env[s]))));
      const checked = e.authCheck ? opts?.checks?.[e.name] : undefined;
      const authed = checked === 'ok' ? true : checked === 'failed' ? false : envAuthed;
      return { name: e.name, description: e.description, kind: e.kind, installed, authed, docs: e.docs };
    });
}
