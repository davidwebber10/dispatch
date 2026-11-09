import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The deny-list for file reads (engineering program W1-B).
 *
 * The read route serves an absolute path outside the project (the "View file" button for an agent
 * that edits another repository). Without a list, that same route serves the access token, the
 * database and the user's SSH keys to every caller that reaches it. A path on this list is never
 * served, to any caller, the owner included: the web page has no use for these files.
 *
 * The caller gives the REAL path (after `fs.realpath`), so a symbolic link cannot go around the
 * list. The compare ignores letter case: the default macOS disk does, and a refusal of `~/.SSH`
 * on a disk that does not costs nothing.
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
];
/** SQLite files, at any depth in the data dir. */
const DB_FILE = /\.db(-wal|-shm|-journal)?$/;

/** Folders in the home folder: everything in them is denied. */
const HOME_DIRS = [
  '.ssh', '.aws', '.gnupg', '.config/gcloud', '.cloudflared', '.kube', 'library/keychains',
];
/** Single files in the home folder. */
const HOME_FILES = [
  '.docker/config.json', '.netrc', '.npmrc',
  '.claude/.credentials.json', '.claude/credentials.json',
  '.codex/auth.json', '.grok/auth.json', '.local/share/opencode/auth.json',
  '.config/gh/hosts.yml',
];

/** `p` relative to `root`, lower case, with `/` between the parts. null when `p` is not inside `root`. */
function relativeInside(root: string, p: string): string | null {
  const rel = path.relative(path.resolve(root).toLowerCase(), path.resolve(p).toLowerCase());
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

const isOrUnder = (rel: string, dir: string) => rel === dir || rel.startsWith(`${dir}/`);

/** True when `realPath` is a place that holds credentials. Text only: it reads nothing from the disk. */
export function isSecretPath(realPath: string, roots: SecretRoots): boolean {
  const inData = relativeInside(roots.dataDir, realPath);
  if (inData !== null) {
    if (DATA_DIRS.some((d) => isOrUnder(inData, d))) return true;
    if (DATA_FILES.some((f) => inData === f || (inData.startsWith(`${f}.`) && !inData.includes('/')))) return true;
    if (DB_FILE.test(inData)) return true;
  }
  const inHome = relativeInside(roots.home, realPath);
  if (inHome !== null) {
    if (HOME_DIRS.some((d) => isOrUnder(inHome, d))) return true;
    if (HOME_FILES.includes(inHome)) return true;
  }
  return false;
}

const realOr = (p: string): string => {
  try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); }
};

/** The roots of this machine: the real location of the home folder and of the data dir. */
export function defaultSecretRoots(dataDir: string, home: string = os.homedir()): SecretRoots {
  return { home: realOr(home), dataDir: realOr(dataDir) };
}
