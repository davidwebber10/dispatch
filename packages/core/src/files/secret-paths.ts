import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

/**
 * The deny-list for file reads (engineering program W1-B).
 *
 * The read route serves an absolute path outside the project (the "View file" button for an agent
 * that edits another repository). Without a list, that same route serves the access token, the
 * database and the user's SSH keys to every caller that reaches it. A path on this list is never
 * served, to any caller, the owner included: the web page has no use for these files.
 *
 * Two checks (the second since the v4.5.0 review, finding I4):
 *
 * 1. The TEXT of the path (`isSecretPath`). The caller gives the REAL path (after `fs.realpath`), so a
 *    symbolic link cannot go around the list. The compare ignores letter case: the default macOS disk
 *    does, and a refusal of `~/.SSH` on a disk that does not costs nothing. The macOS prefix
 *    `/System/Volumes/Data` is dropped first: `/System/Volumes/Data/Users/x` is a second name of
 *    `/Users/x`, and `realpath` keeps it.
 * 2. The IDENTITY of the file (`holdsSecret`): its device and inode. The text of a path is not the file.
 *    A hard link gives a secret file a second name anywhere on the same disk, and a second mount path
 *    gives a secret folder a second name. So the file that is served is compared with the secret files,
 *    and each folder above it is compared with the home folder, the data dir and the secret folders.
 *
 * A route that serves the bytes of a file calls `holdsSecret`, with the open file when it has one.
 */
export interface SecretRoots {
  /** The user's home folder (real path). */
  home: string;
  /** The Dispatch data folder, `~/.dispatch` (real path). */
  dataDir: string;
}

/** The body of the 403 answer. */
export const SECRET_PATH_ERROR = 'This path holds credentials. Dispatch does not serve it.';

/** Files directly in the data dir. An atomic write leaves `<name>.<something>` beside the file for a moment: that is denied too. */
const DATA_FILES = [
  'access-token',       // the owner's access token (auth/access-token.ts)
  'accounts.json',      // saved Claude logins (auth/accounts.ts)
  'claude-oauth-token', // the single saved login of earlier versions (auth/claude-login.ts)
  'doppler.json',       // the Doppler token (secrets/service.ts)
  'push.json',          // the private web push key (push/service.ts)
];
/** Folders in the data dir: everything in them is denied. */
const DATA_DIRS = [
  'keys',           // thread, plugin and shell keys
  'codex-accounts', // one CODEX_HOME for each saved Codex login, with its auth.json
  'inbox-secrets',  // the values the owner sent through Inbox → Send a secret (inbox/secret-store.ts)
];
/** SQLite files, at any depth in the data dir. */
const DB_FILE = /\.db(-wal|-shm|-journal)?$/;

/** Folders in the home folder: everything in them is denied. */
const HOME_DIRS = [
  '.ssh', '.aws', '.gnupg', '.config/gcloud', '.cloudflared', '.kube', 'library/keychains',
  '.azure', '.password-store', '.zsh_sessions',
];
/** Single files in the home folder. */
const HOME_FILES = [
  '.docker/config.json', '.netrc', '.npmrc',
  '.claude/.credentials.json', '.claude/credentials.json',
  '.codex/auth.json', '.grok/auth.json', '.local/share/opencode/auth.json',
  '.config/gh/hosts.yml',
  '.git-credentials', '.config/git/credentials', // the two places of git's `store` credential helper
  '.pgpass', '.my.cnf', // database passwords
  // What was typed into a shell or a REPL: commands with tokens in them, pasted secrets.
  '.bash_history', '.zsh_history', '.zhistory', '.sh_history', '.history', '.local/share/fish/fish_history',
  '.python_history', '.node_repl_history', '.psql_history', '.mysql_history', '.sqlite_history', '.rediscli_history', '.lesshst', '.viminfo',
];

/** The macOS data volume. A path under it is a second name of the same path without it. */
const DATA_VOLUME = '/system/volumes/data';

/**
 * `p` as an absolute path without the `/System/Volumes/Data` prefix. On macOS that prefix is a second way to
 * every file of the data volume (`/Users`, `/private`, ...). On another system no such folder exists, so the rule
 * costs nothing there.
 */
function plainPath(p: string): string {
  let abs = path.resolve(p);
  for (;;) {
    const low = abs.toLowerCase();
    if (low === DATA_VOLUME) return path.sep;
    if (!low.startsWith(`${DATA_VOLUME}/`)) return abs;
    abs = abs.slice(DATA_VOLUME.length);
  }
}

/** `p` relative to `root`, lower case, with `/` between the parts. null when `p` is not inside `root`. */
function relativeInside(root: string, p: string): string | null {
  const rel = path.relative(plainPath(root).toLowerCase(), plainPath(p).toLowerCase());
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

const isOrUnder = (rel: string, dir: string) => rel === dir || rel.startsWith(`${dir}/`);

/** The rule for a path inside the data dir. `rel` is relative to it, lower case, with `/` between the parts. */
const secretInData = (rel: string): boolean =>
  DATA_DIRS.some((d) => isOrUnder(rel, d))
  || DATA_FILES.some((f) => rel === f || (rel.startsWith(`${f}.`) && !rel.includes('/')))
  || DB_FILE.test(rel);

/** The rule for a path inside the home folder. */
const secretInHome = (rel: string): boolean => HOME_DIRS.some((d) => isOrUnder(rel, d)) || HOME_FILES.includes(rel);

/** True when `realPath` is a place that holds credentials. Text only: it reads nothing from the disk. */
export function isSecretPath(realPath: string, roots: SecretRoots): boolean {
  const inData = relativeInside(roots.dataDir, realPath);
  if (inData !== null && secretInData(inData)) return true;
  const inHome = relativeInside(roots.home, realPath);
  return inHome !== null && secretInHome(inHome);
}

// ── file identity ──────────────────────────────────────────────────────────────────────────────────────────────

/** A file's identity: device and inode. Two paths with the same identity are the same file. */
type Id = string;
const idOf = (st: fs.BigIntStats): Id => `${st.dev}:${st.ino}`;
// bigint: an inode number can be larger than a JavaScript number holds exactly.
const statOrNull = async (p: string): Promise<fs.BigIntStats | null> => {
  try { return await fs.promises.stat(p, { bigint: true }); } catch { return null; }
};

/** The identities that cost a few `stat` calls: the two roots, the secret folders, the single secret files. */
interface Shallow { home: Id | null; data: Id | null; dirs: Set<Id>; files: Set<Id> }

async function readShallow(roots: SecretRoots): Promise<Shallow> {
  const dirs = new Set<Id>();
  const files = new Set<Id>();
  const add = async (set: Set<Id>, p: string) => { const st = await statOrNull(p); if (st) set.add(idOf(st)); };
  const jobs: Promise<void>[] = [
    ...HOME_DIRS.map((d) => add(dirs, path.join(roots.home, d))),
    ...DATA_DIRS.map((d) => add(dirs, path.join(roots.dataDir, d))),
    ...HOME_FILES.map((f) => add(files, path.join(roots.home, f))),
  ];
  // The files directly in the data dir that the text rule denies: the listed names in any letter case, the temp copy
  // of an atomic write, a database.
  let names: string[] = [];
  try { names = await fs.promises.readdir(roots.dataDir); } catch { /* no data dir: no such file */ }
  for (const n of names) {
    const low = n.toLowerCase();
    if (secretInData(low) && !DATA_DIRS.includes(low)) jobs.push(add(files, path.join(roots.dataDir, n)));
  }
  const [home, data] = await Promise.all([statOrNull(roots.home), statOrNull(roots.dataDir), ...jobs]);
  return { home: home ? idOf(home) : null, data: data ? idOf(data) : null, dirs, files };
}

/** At most this many folder entries are looked at in one secret folder (and in the data dir), nearest first. */
const WALK_BUDGET = 20_000;

/**
 * The identity of every file in `root`, nearest level first. With `only`, of the files whose name matches.
 * Links are not followed. Stops at the budget: a folder with more entries than that is covered down to the level
 * the budget reaches.
 */
async function collectIds(root: string, out: Set<Id>, only: RegExp | null): Promise<void> {
  let left = WALK_BUDGET;
  let level = [root];
  while (level.length > 0 && left > 0) {
    const next: string[] = [];
    for (const dir of level) {
      if (left <= 0) break;
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      const found: string[] = [];
      for (const e of entries) {
        if (left-- <= 0) break;
        if (e.isDirectory()) next.push(path.join(dir, e.name));
        else if (e.isFile() && (!only || only.test(e.name.toLowerCase()))) found.push(path.join(dir, e.name));
      }
      for (let i = 0; i < found.length; i += 32) {
        const sts = await Promise.all(found.slice(i, i + 32).map((f) => fs.promises.lstat(f, { bigint: true }).catch(() => null)));
        for (const st of sts) if (st?.isFile()) out.add(idOf(st));
      }
    }
    level = next;
  }
}

/** The identity of every file in a secret folder, and of every database file in the data dir. */
async function readDeep(roots: SecretRoots): Promise<Set<Id>> {
  const out = new Set<Id>();
  await Promise.all([
    ...HOME_DIRS.map((d) => collectIds(path.join(roots.home, d), out, null)),
    ...DATA_DIRS.map((d) => collectIds(path.join(roots.dataDir, d), out, null)),
    collectIds(roots.dataDir, out, DB_FILE),
  ]);
  return out;
}

/**
 * A short memory of the two readings, for a route that checks many files in one request (the diff review). The
 * secret files live for days; a reading that is a second old is as good as a new one.
 */
function remember<T>(read: (roots: SecretRoots) => Promise<T>, ttlMs: number): (roots: SecretRoots) => Promise<T> {
  const kept = new Map<string, { at: number; value: Promise<T> }>();
  return (roots) => {
    const key = `${roots.home}\0${roots.dataDir}`;
    const hit = kept.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    if (kept.size >= 8) kept.clear();
    const value = read(roots);
    kept.set(key, { at: Date.now(), value });
    value.catch(() => { if (kept.get(key)?.value === value) kept.delete(key); });
    return value;
  };
}
const shallowOf = remember(readShallow, 1_000);
const deepOf = remember(readDeep, 10_000);

/** True when a folder above `start` (or `start` itself, for a folder) is a secret folder, or is one of the roots and the rest of the path is a secret there. */
async function secretByFolder(start: string, isDir: boolean, sh: Shallow): Promise<boolean> {
  const chain: string[] = [];
  for (let p = isDir ? start : path.dirname(start); ; p = path.dirname(p)) {
    chain.push(p);
    if (path.dirname(p) === p) break;
  }
  const sts = await Promise.all(chain.map(statOrNull));
  for (let i = 0; i < chain.length; i++) {
    const st = sts[i];
    if (!st) continue;
    const id = idOf(st);
    if (sh.dirs.has(id)) return true;
    const rel = path.relative(chain[i], start).split(path.sep).join('/').toLowerCase();
    if (rel === '') continue;
    if (id === sh.data && secretInData(rel)) return true;
    if (id === sh.home && secretInHome(rel)) return true;
  }
  return false;
}

/**
 * True when the file at `filePath` holds credentials: by the text of the path, by the text of its real path, or by
 * the identity of the file. Give the OPEN file as `fh` when the route has one: then the bytes that are served and
 * the file that was checked are the same file, whatever happened to the path meanwhile.
 *
 * What the identity check sees that the text does not:
 *   - a hard link to a secret file, anywhere;
 *   - a second path to the home folder, the data dir or a secret folder (a bind mount, a macOS firmlink, a name
 *     the disk treats as equal to the written one).
 * Limits: a hard link to a file deep in a secret folder is found by a walk of that folder, at most
 * `WALK_BUDGET` entries for each folder, nearest level first, and the walk is kept for 10 seconds. A file that
 * does not exist is judged by the text alone.
 */
export async function holdsSecret(filePath: string, roots: SecretRoots, fh?: FileHandle): Promise<boolean> {
  const abs = path.resolve(filePath);
  if (isSecretPath(abs, roots)) return true;
  let real: string | null = null;
  try { real = await fs.promises.realpath(abs); } catch { /* missing or dangling */ }
  if (real !== null && isSecretPath(real, roots)) return true;
  let st: fs.BigIntStats | null;
  try { st = fh ? await fh.stat({ bigint: true }) : await statOrNull(real ?? abs); } catch { st = null; }
  if (!st) return false; // nothing is there to serve
  const sh = await shallowOf(roots);
  const id = idOf(st);
  if (st.isFile() && sh.files.has(id)) return true;
  if (await secretByFolder(real ?? abs, st.isDirectory(), sh)) return true;
  // A file with one name has no hard link: only a file with more names needs the walk.
  if (st.isFile() && st.nlink > 1n) return (await deepOf(roots)).has(id);
  return false;
}

const realOr = (p: string): string => {
  try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); }
};

/** The roots of this machine: the real location of the home folder and of the data dir. */
export function defaultSecretRoots(dataDir: string, home: string = os.homedir()): SecretRoots {
  return { home: realOr(home), dataDir: realOr(dataDir) };
}
