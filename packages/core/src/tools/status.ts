import fs from 'node:fs';
import path from 'node:path';
import { toolPaths, hostOsFamily } from './paths.js';
import { loadManifest } from './manifest.js';
import type { ToolStatus } from './types.js';
export { getToolsSpawnEnv } from './spawnEnv.js';
export { awarenessNote } from './awareness.js';

export function toolStatuses(opts?: { base?: string; env?: Record<string, string | undefined> }): ToolStatus[] {
  const env = opts?.env ?? process.env;
  const p = toolPaths(opts?.base);
  const family = hostOsFamily();
  return loadManifest(opts?.base)
    .filter((e) => !e.platforms || e.platforms.includes(family))
    .map((e) => {
      const installed = e.bins.every((b) => fs.existsSync(path.join(p.bin, b)));
      const authed = !e.authEnv?.length ? true : e.authEnv.every((k) => !!(env[k] || (e.envAlias && Object.entries(e.envAlias).some(([w, s]) => w === k && env[s]))));
      return { name: e.name, description: e.description, kind: e.kind, installed, authed, docs: e.docs };
    });
}
