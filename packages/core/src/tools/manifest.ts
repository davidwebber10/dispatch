import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { toolPaths } from './paths.js';
import type { ToolEntry } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function validateEntry(e: unknown): e is ToolEntry {
  if (!e || typeof e !== 'object') return false;
  const t = e as Record<string, unknown>;
  if (typeof t.name !== 'string' || typeof t.description !== 'string') return false;
  if (t.kind !== 'binary' && t.kind !== 'npm' && t.kind !== 'script') return false;
  if (!Array.isArray(t.bins) || !t.bins.every((b) => typeof b === 'string')) return false;
  return true;
}

function readJson(file: string): any { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

export function loadManifest(base?: string): ToolEntry[] {
  const p = toolPaths(base);
  const def = readJson(path.join(here, 'default-tools.json'));
  const defaults: unknown[] = Array.isArray(def?.tools) ? def.tools : [];
  const user = readJson(p.userManifest);
  const extras: unknown[] = Array.isArray(user?.tools) ? user.tools : [];
  const byName = new Map<string, ToolEntry>();
  for (const e of defaults) if (validateEntry(e)) byName.set(e.name, e);
  for (const e of extras) if (validateEntry(e)) byName.set(e.name, e); // user overrides/extends
  return [...byName.values()];
}
