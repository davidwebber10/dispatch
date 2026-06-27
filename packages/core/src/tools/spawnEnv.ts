import path from 'node:path';
import { toolPaths } from './paths.js';
import { loadManifest } from './manifest.js';

export function getToolsSpawnEnv(opts?: { base?: string; env?: Record<string, string | undefined> }): Record<string, string> {
  const env = opts?.env ?? process.env;
  const p = toolPaths(opts?.base);
  const out: Record<string, string> = {};
  out.PATH = p.bin + path.delimiter + (env.PATH ?? '');
  for (const entry of loadManifest(opts?.base)) {
    for (const [want, src] of Object.entries(entry.envAlias ?? {})) {
      const v = env[src];
      if (v && !env[want]) out[want] = v;
    }
  }
  return out;
}
