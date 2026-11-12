// packages/core/src/sessions/project-dir.ts
// Project folders: `~` expansion (a `~/x` path must never reach chdir(2) as it is) and the folder of a
// project a hosted box creates from a name alone (~/projects/<safe-name>, de-duplicated).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdirForAgent } from '../privsep/paths.js';

/** `~` or `~/x` → the home folder. Any other path is returned as it is. */
export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** A folder name from a project name: letters, digits, dot, dash and underscore; never empty, never `.`/`..`. */
export function safeFolderName(name: string): string {
  const s = name.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
  return s && s !== '.' && s !== '..' ? s : 'project';
}

/** `~/projects/<safe-name>`, created; `-2`, `-3`… when a folder of that name exists. */
export function hostedProjectDir(name: string, home: string = os.homedir()): string {
  const root = path.join(home, 'projects');
  const base = safeFolderName(name);
  let dir = path.join(root, base);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(root, `${base}-${n}`);
  mkdirForAgent(dir, { confine: false });
  return dir;
}
