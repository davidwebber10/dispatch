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
  if (t.platforms !== undefined && (!Array.isArray(t.platforms) || !t.platforms.every((p) => typeof p === 'string'))) return false;
  if (t.authCheck !== undefined && !validAuthCheck(t.authCheck)) return false;
  return true;
}

function validAuthCheck(c: unknown): boolean {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  const a = c as Record<string, unknown>;
  if ((a.args === undefined) === (a.shell === undefined)) return false; // exactly one of the two
  if (a.args !== undefined && (!Array.isArray(a.args) || !a.args.every((x) => typeof x === 'string'))) return false;
  if (a.shell !== undefined && typeof a.shell !== 'string') return false;
  if (a.timeoutMs !== undefined && (typeof a.timeoutMs !== 'number' || !Number.isFinite(a.timeoutMs) || a.timeoutMs <= 0)) return false;
  if (a.unknownExitCodes !== undefined && (!Array.isArray(a.unknownExitCodes)
    || !a.unknownExitCodes.every((x) => Number.isInteger(x) && x >= 1 && x <= 255))) return false;
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
