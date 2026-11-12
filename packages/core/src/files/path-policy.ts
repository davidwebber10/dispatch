// packages/core/src/files/path-policy.ts
// Which paths a file route may touch. ONE function for every route that takes a path or a file id:
// read, write, list, serve, download, upload, rename, delete, mkdir, the folder browser, a new
// project's folder, a file handed to a plugin, a file reference typed into a thread.
//
// Three layers, checked on the REAL path (every symbolic link on the way followed first):
//
//   1. Never, on any install, for any caller: the kernel's and the system's own trees (`/proc`,
//      `/sys`, `/dev`, `/run`). `/proc/<pid>/environ` is the environment of a process; none of these
//      is a file of the person. (The credential files are refused by files/secret-paths.ts, as before.)
//
//   2. On a HOSTED box, an allow-list instead of the old "any absolute path may be read":
//        developer   the home folder and the project folders;
//        business    the folder of the project the request names, and that folder must be inside
//                    `~/projects`.
//      and never: the daemon's data folder (its database, keys, logs; with privilege separation also
//      the folder in the home that held it before, where the harness account folders stay), the app
//      folder of the image,
//      the configuration and credential folders of the harnesses, or a regular file with more than
//      one name on the disk (a hard link can give a file outside these folders a name inside them;
//      a path cannot tell). Dependency folders (`node_modules`) keep their hard links for a developer.
//
//   3. For a BUSINESS person also: nothing in a folder or file of a project that configures a
//      harness or runs code (`.claude`, `.codex`, `.git`, `.mcp.json`, …). A file there is a way to
//      add a tool, a hook or an instruction without asking. `.dispatch/inbox` (uploads) stays.
//
// A LOCAL install keeps what it had: a relative path stays in the project, an absolute path may be
// read ("View file" for an agent that works in another repository). Only layer 1 is new there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extraRoots, within } from './confine.js';

export type Profile = 'business' | 'developer';
export type FileUse = 'read' | 'write';

export interface PathPolicyContext {
  /** True on a box the platform provisioned (os/hosted-mode.ts). */
  hosted: boolean;
  profile: Profile;
  /** The person's home folder. */
  home: string;
  /** The daemon's data folder (`~/.dispatch`). */
  dataDir: string;
  /**
   * With privilege separation (privsep/config.ts): the folder in the home that was the data folder
   * before the daemon's state moved out of the home (`~/.dispatch`). It still holds the account
   * folders of the harnesses, with their sign-in files, so it stays refused like the data folder.
   */
  agentDataDir?: string | null;
  /** The folder the daemon's own code runs from, when it is not a folder of the person (the image's `/app`). */
  appDir: string | null;
  /** The folder of every live project. */
  projectDirs: () => string[];
}

/** The body of each refusal. Plain sentences; none names a path the caller did not send. */
export const PATH_REFUSALS = {
  system: 'This path belongs to the system. Dispatch does not serve it.',
  outside: 'This path is outside your folders.',
  daemon: 'This path belongs to Dispatch itself. Dispatch does not serve it.',
  harness: 'This path holds the settings of an agent program. It is not available here.',
  hardlink: 'This file has more than one name on the disk. Dispatch does not serve it here.',
} as const;
export type PathRefusal = keyof typeof PATH_REFUSALS;

/** The kernel's and the system's own trees. On macOS `/var/run` is `/private/var/run`. */
const SYSTEM_TREES = ['/proc', '/sys', '/dev', '/run', '/var/run', '/private/var/run'];

/**
 * In the home folder of a hosted box: where the harnesses keep their settings, sessions and sign-ins.
 * (The credential FILES among them are also on the list of files/secret-paths.ts, for every install.)
 */
const HOSTED_HOME_DENY = [
  '.claude', '.claude.json', '.claude.json.backup', '.codex', '.grok', '.gemini', '.opencode',
  '.config/claude', '.config/opencode', '.config/codex', '.local/share/opencode', '.local/state/opencode', '.cache/opencode',
  '.config/gh', '.config/git', '.git-credentials',
];

/** In a project, for a business person: folders and files that configure a harness or run code. Lower case. */
const BUSINESS_DENY_SEGMENTS = new Set(['.claude', '.codex', '.grok', '.gemini', '.opencode', '.cursor', '.agents', '.git', '.githooks', '.husky', '.vscode', '.devcontainer']);
const BUSINESS_DENY_FILES = new Set(['.mcp.json', '.claude.json', 'opencode.json', 'opencode.jsonc', '.envrc', '.npmrc', '.gitconfig', '.gitmodules']);

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

/**
 * `p` with every link on the way followed, as far as the path exists; the rest is appended as written.
 * A link whose target does not exist (yet) is followed too: a write through it would make the file at
 * the target, and a read of it names the target.
 */
export function realAsFarAsItExists(p: string, depth = 0): string {
  let probe = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(probe), ...rest); } catch { /* not there, or a link to nowhere */ }
    try {
      if (depth < 40 && fs.lstatSync(probe).isSymbolicLink()) {
        const to = path.resolve(path.dirname(probe), fs.readlinkSync(probe));
        return realAsFarAsItExists(path.join(to, ...rest), depth + 1);
      }
    } catch { /* not there at all */ }
    const parent = path.dirname(probe);
    if (parent === probe) return path.resolve(p);
    rest.unshift(path.basename(probe));
    probe = parent;
  }
}

const real = (p: string): string => { try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); } };
const strictlyWithin = (root: string, p: string): boolean => p !== root && within(root, p);
const underAny = (roots: readonly string[], p: string): boolean => roots.some((r) => within(r, p));

/**
 * Where some Linux systems (Fedora, Arch, openSUSE) mount removable drives: `/run/media/<user>/…`. On a
 * local install a project there is the person's own; `/run` itself and the rest of it stay refused.
 */
const LOCAL_MEDIA_TREES = ['/run/media', '/var/run/media'];

/** True when `p` (text or real) is in one of the system's own trees. `hosted`: a hosted box, where every tree is refused. */
export function inSystemTree(p: string, hosted = true): boolean {
  const abs = path.resolve(p);
  if (!hosted && LOCAL_MEDIA_TREES.some((t) => strictlyWithin(t, abs))) return false;
  return SYSTEM_TREES.some((t) => within(t, abs));
}

/** The relative path of `realPath` in a business project, when it may not be touched there; else null. */
function businessProjectProblem(projectReal: string, realPath: string): PathRefusal | null {
  const rel = path.relative(projectReal, realPath);
  if (rel === '') return null;
  const parts = rel.split(path.sep).map((s) => s.toLowerCase());
  // The project's own `.dispatch` folder: only the inbox (uploads) is the person's.
  if (parts[0] === '.dispatch') return parts.length === 1 || parts[1] === 'inbox' ? null : 'harness';
  if (parts.some((s) => BUSINESS_DENY_SEGMENTS.has(s) || BUSINESS_DENY_FILES.has(s))) return 'harness';
  return null;
}

export interface PathQuestion {
  /** The folder of the project the request names (its `:id`). */
  project: string;
  use: FileUse;
  /** The route acts on the item itself (rename, delete): a link at the END of the path is not followed. */
  self?: boolean;
}

export class PathPolicy {
  constructor(private readonly ctx: () => PathPolicyContext) {}

  /** The context now (the profile is live). */
  context(): PathPolicyContext { return this.ctx(); }

  /**
   * Why `target` may not be touched, or null. `target` is the path a route resolved (absolute). The
   * answer is about the real path: a link is followed before anything is compared.
   */
  problem(target: string, q: PathQuestion): PathRefusal | null {
    const c = this.ctx();
    const abs = path.resolve(target);
    const realPath = q.self ? path.join(realAsFarAsItExists(path.dirname(abs)), path.basename(abs)) : realAsFarAsItExists(abs);
    // 1. Everywhere.
    if (inSystemTree(abs, c.hosted) || inSystemTree(realPath, c.hosted)) return 'system';
    if (!c.hosted) return null;
    // 2. A hosted box.
    const home = real(c.home);
    const dataDir = real(c.dataDir);
    if (within(dataDir, realPath)) return 'daemon';
    if (c.agentDataDir && within(real(c.agentDataDir), realPath)) return 'daemon';
    if (c.appDir && within(real(c.appDir), realPath)) return 'daemon';
    const inHome = within(home, realPath) ? path.relative(home, realPath).split(path.sep).join('/').toLowerCase() : null;
    if (inHome !== null && HOSTED_HOME_DENY.some((d) => inHome === d || inHome.startsWith(`${d}/`))) return 'harness';
    const projectReal = real(q.project);
    if (c.profile === 'business') {
      // The project the request names, and it must be a folder of `~/projects`.
      if (!strictlyWithin(real(path.join(c.home, 'projects')), projectReal)) return 'outside';
      if (!within(projectReal, realPath)) return 'outside';
      return businessProjectProblem(projectReal, realPath);
    }
    const allowed = [home, projectReal, ...c.projectDirs().map(real), ...extraRoots()];
    return underAny(allowed, realPath) ? null : 'outside';
  }

  /**
   * After the file is OPEN (or just before a write to a file that exists): a regular file with more than
   * one name is refused on a hosted box. `realPath` only decides the dependency-folder exception.
   */
  openedProblem(st: { isFile(): boolean; nlink: number | bigint }, realPath: string): PathRefusal | null {
    const c = this.ctx();
    if (!c.hosted || !st.isFile() || Number(st.nlink) <= 1) return null;
    if (c.profile === 'developer' && `${realPath}${path.sep}`.includes(NODE_MODULES)) return null;
    return 'hardlink';
  }

  /**
   * For a listing of a project: true for an entry that is left out, because a business person may not
   * open it. `rel` is the entry's path in the project. Text only (a listing may hold 20,000 names); the
   * route that opens an entry asks `problem`, which follows the links.
   */
  hiddenInListing(rel: string): boolean {
    const c = this.ctx();
    if (!c.hosted || c.profile !== 'business') return false;
    return businessProjectProblem('/', path.join('/', rel)) !== null;
  }
}

/** A policy for a local install in the developer profile: only the system trees are refused. */
export const LOCAL_PATH_POLICY = new PathPolicy(() => ({
  hosted: false, profile: 'developer', home: os.homedir(), dataDir: path.join(os.homedir(), '.dispatch'), appDir: null, projectDirs: () => [],
}));
