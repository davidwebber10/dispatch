// packages/core/src/os/login-policy.ts
// Claude Code's forced login (`forceLoginMethod: "claudeai"`) on a hosted box, as a root-owned drop-in.
//
// The forced login stops a Claude Code process that has ANTHROPIC_AUTH_TOKEN before any request
// (measured with 2.1.322, docs/hosted.md "Company models"), so a company-model thread cannot run under
// it. The image therefore keeps the setting OUT of its main policy file and IN a drop-in of Claude
// Code's managed folder (/etc/claude-code/managed-settings.d, a link to /run/dispatch/claude-policy):
//
//   the image   bakes the drop-in into the folder (present on every box from the first start);
//   the entrypoint (as root) empties the folder at each start and writes the drop-in again;
//   the daemon  (as root, privilege separation) removes it ONLY while the platform's CURRENT answer
//               grants a company Claude model AND turns the person's own Claude login off
//               (`subscriptions.claude: false`: a company-billed person). It writes it back as soon as
//               that stops being true. No answer from the platform: present (fail closed).
//
// Only root writes the folder (os/hosted-mcp-policy.ts dropInFolderProblem); a daemon that is not root
// changes nothing and the drop-in stays as the image left it. The capability `company-claude-v1` is
// reported only while no managed file forces the login (`companyClaudePermitted`).
import fs from 'node:fs';
import path from 'node:path';
import { dropInFolderProblem, dropInPaths, type DropInPaths } from './hosted-mcp-policy.js';
import { claudeSubscriptionAllowed, isGrantedCompanyClaude, type ModelAccess } from './company-model.js';

/** The drop-in that forces the login. Read before the business MCP allow-list (`50-…`). */
export const LOGIN_DROPIN_FILE = '10-dispatch-login.json';
export const LOGIN_DROPIN_DOC: Readonly<Record<string, unknown>> = Object.freeze({ forceLoginMethod: 'claudeai' });
/** The image's main Claude Code policy file. */
export const CLAUDE_MANAGED_FILE = '/etc/claude-code/managed-settings.json';

export function managedFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DISPATCH_CLAUDE_MANAGED_FILE || CLAUDE_MANAGED_FILE;
}

/**
 * True when the forced login may be lifted now: the platform grants a company Claude model and turns
 * the person's own Claude login off. Null (no answer) is false: the login stays forced.
 */
export function mayLiftForcedLogin(access: ModelAccess | null): boolean {
  if (!access) return false;
  if (claudeSubscriptionAllowed(access)) return false;
  return access.models.some((m) => isGrantedCompanyClaude(access, m));
}

const ownUid = (): number | null => (typeof process.getuid === 'function' ? process.getuid() : null);

function readIfOwned(file: string, owner: number): string | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.uid !== owner || (st.mode & 0o022) !== 0) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

/**
 * Put the login drop-in in place (`forced`) or remove it. Returns null when the folder holds what was
 * asked, else the reason (then nothing was changed). Root only; atomic (a hidden temporary name, then a
 * rename), root-owned, mode 644.
 */
export function applyLoginDropIn(forced: boolean, p: DropInPaths = dropInPaths(), uid: number | null = ownUid(), owner = 0): string | null {
  const problem = dropInFolderProblem(p, uid, owner);
  if (problem) return problem;
  const file = path.join(p.dir, LOGIN_DROPIN_FILE);
  if (!forced) {
    try { fs.rmSync(file, { force: true }); } catch (e) { return `could not remove ${file}: ${(e as Error).message}`; }
    return fs.existsSync(file) ? `${file} is still there` : null;
  }
  const text = `${JSON.stringify(LOGIN_DROPIN_DOC, null, 2)}\n`;
  if (readIfOwned(file, owner) === text) return null;
  try {
    // A dot name while it is written: Claude Code reads only `*.json` and skips hidden files.
    const tmp = path.join(p.dir, `.${LOGIN_DROPIN_FILE}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, text, { mode: 0o644 });
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, file);
  } catch (e) { return `could not write ${file}: ${(e as Error).message}`; }
  return readIfOwned(file, owner) === text ? null : `${file} did not hold what was written`;
}

function forcesLogin(text: string | null): boolean {
  if (text === null) return false;
  try {
    const doc = JSON.parse(text) as Record<string, unknown> | null;
    return !!doc && typeof doc === 'object' && doc.forceLoginMethod !== undefined;
  } catch { return true; } // a file Claude Code may read differently: count it as forcing
}

/**
 * True when no managed file forces the login now: the main file (absent counts as not forcing) and
 * every `*.json` of the managed folder. A folder that cannot be listed counts as not forcing only when
 * it does not exist.
 */
export function companyClaudePermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  const main = managedFilePath(env);
  let mainText: string | null = null;
  try { mainText = fs.readFileSync(main, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
  if (forcesLogin(mainText)) return false;
  const folder = dropInPaths(env).link;
  let names: string[];
  try { names = fs.readdirSync(folder); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT'; }
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    let text: string | null = null;
    try { text = fs.readFileSync(path.join(folder, name), 'utf8'); } catch { return false; }
    if (forcesLogin(text)) return false;
  }
  return true;
}

/**
 * Follow the platform: lift the forced login while `mayLiftForcedLogin`, else keep it. `gateway`: the
 * image's model-gateway mode (DISPATCH_ALLOW_MODEL_GATEWAY=1) never forces it. Returns what it did,
 * for the box log; never throws.
 */
export function syncLoginPolicy(
  access: ModelAccess | null,
  opts: { gateway?: boolean; paths?: DropInPaths; uid?: number | null; owner?: number } = {},
): { forced: boolean; problem: string | null } {
  const forced = opts.gateway ? false : !mayLiftForcedLogin(access);
  try {
    return { forced, problem: applyLoginDropIn(forced, opts.paths ?? dropInPaths(), opts.uid === undefined ? ownUid() : opts.uid, opts.owner ?? 0) };
  } catch (e) {
    return { forced, problem: (e as Error).message };
  }
}
