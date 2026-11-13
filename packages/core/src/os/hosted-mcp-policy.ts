// packages/core/src/os/hosted-mcp-policy.ts
// Which MCP servers a thread on a HOSTED box may have (2026-11-12).
//
// The rule: an agent reaches company systems only through the platform's gateway. So a thread never
// gets the connectors of the person's own AI account (claude.ai connectors, ChatGPT apps), never a
// server from user or project scope, and never a server added at run time.
//
//   business   the platform's per-system servers, Dispatch's own `dispatch` server (threads, status)
//              and the servers of BUNDLED plugins (the Inbox). Nothing else.
//   developer  the same, plus what the developer added through Dispatch's own screens (integrations,
//              the Doppler secrets server, local plugins).
//   local      (not hosted) unchanged.
//
// Where each layer lives:
//   1. The image's root-owned policy: Claude Code `disableClaudeAiConnectors: true` (every profile);
//      Codex `[features] apps = false` (docker/hosted/policy).
//   2. Business only: a root-owned drop-in that this module writes into Claude Code's managed folder
//      (/etc/claude-code/managed-settings.d is a link to DROPIN_DIR): `allowManagedMcpServersOnly`
//      and an allow-list of exactly the URL of the box's loopback routes and the commands of the
//      bundled servers. A `claude mcp add`, a project `.mcp.json`, a user allow-list or an
//      `--mcp-config` of a nested harness cannot add a server. Only root writes the folder, so only
//      a box with privilege separation can run a business thread (checked at spawn).
//   3. The launch: `--strict-mcp-config` (only the servers Dispatch passes) and
//      ENABLE_CLAUDEAI_MCP_SERVERS=false, for Claude Code under every hosted profile.
//   4. The check: the `system/init` frame of a Claude Code thread names its servers; the box logs
//      them (`thread.mcp`) and warns, in the log and in the thread, about any name it did not pass.
import fs from 'node:fs';
import path from 'node:path';
import type { McpServerSpec } from '../mcp/injection.js';

/** Claude Code's managed drop-in folder, and where the image links it (docker/hosted/Dockerfile). */
export const CLAUDE_DROPIN_LINK = '/etc/claude-code/managed-settings.d';
export const DEFAULT_DROPIN_DIR = '/run/dispatch/claude-policy';
export const BUSINESS_DROPIN_FILE = '50-dispatch-business-mcp.json';

/** The launch arguments every Claude Code thread on a hosted box gets. */
export const CLAUDE_HOSTED_MCP_ARGS: readonly string[] = ['--strict-mcp-config'];
/** The environment every Claude Code thread on a hosted box gets: no account connectors, no Artifact tools. */
export const CLAUDE_HOSTED_MCP_ENV: Readonly<Record<string, string>> = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_ARTIFACT: '0' };

export type HostedProfile = 'business' | 'developer';

/**
 * The servers a thread of this profile may have, from what Dispatch composed for it. Business keeps
 * the platform's systems, Dispatch's own server and bundled plugins; a developer keeps everything
 * Dispatch composed (each came from one of Dispatch's own screens).
 */
export function hostedServerSpecs(specs: readonly McpServerSpec[], profile: HostedProfile): McpServerSpec[] {
  if (profile !== 'business') return [...specs];
  // `osSystem`/`platform`: the platform's servers. `bundled`: Dispatch's own server
  // (sessions/spawn-injection.ts) and a plugin that ships with it.
  return specs.filter((s) => !!s.osSystem || s.platform === true || s.bundled === true);
}

/** The allow-list entries Claude Code needs for these servers, as it will see each one. */
export function allowListFor(specs: readonly McpServerSpec[]): Array<{ serverUrl: string } | { serverCommand: string[] }> {
  const out: Array<{ serverUrl: string } | { serverCommand: string[] }> = [];
  const seen = new Set<string>();
  const add = (e: { serverUrl: string } | { serverCommand: string[] }) => {
    const k = JSON.stringify(e);
    if (!seen.has(k)) { seen.add(k); out.push(e); }
  };
  for (const s of specs) {
    // A key-carrying server with a loopback HTTP entry reaches Claude Code as that entry (mcp/injection.ts).
    if (s.http && s.authEnv) {
      const u = new URL(s.http.url);
      add({ serverUrl: `${u.protocol}//${u.host}/*` });
    } else {
      add({ serverCommand: [s.command, ...s.args] });
    }
  }
  return out;
}

/** The business drop-in document. */
export function businessDropIn(specs: readonly McpServerSpec[]): Record<string, unknown> {
  return { allowManagedMcpServersOnly: true, allowedMcpServers: allowListFor(specs) };
}

export interface DropInPaths { dir: string; link: string }
export function dropInPaths(env: NodeJS.ProcessEnv = process.env): DropInPaths {
  return { dir: env.DISPATCH_CLAUDE_POLICY_DIR || DEFAULT_DROPIN_DIR, link: env.DISPATCH_CLAUDE_POLICY_LINK || CLAUDE_DROPIN_LINK };
}

const ownUid = (): number | null => (typeof process.getuid === 'function' ? process.getuid() : null);

/**
 * Why the business drop-in cannot be trusted, or null when it can: the daemon is root (`owner`), the
 * managed link leads to the folder, and the folder and its parent are root's and writable by root only
 * (the image and the entrypoint make /run/dispatch and /run/dispatch/claude-policy so).
 */
export function dropInFolderProblem(p: DropInPaths = dropInPaths(), uid: number | null = ownUid(), owner = 0): string | null {
  if (uid !== owner) return 'the daemon is not root (no privilege separation)';
  let real: string;
  try { real = fs.realpathSync(p.link); } catch { return `${p.link} does not lead to a folder`; }
  let dir: string;
  try { dir = fs.realpathSync(p.dir); } catch { return `${p.dir} is missing`; }
  if (real !== dir) return `${p.link} does not lead to ${p.dir}`;
  for (const d of [dir, path.dirname(dir)]) {
    const st = fs.statSync(d);
    if (st.uid !== owner || (st.mode & 0o022) !== 0) return `${d} may be changed by another user`;
  }
  return null;
}

/**
 * Write (or remove, with null) the business drop-in. Returns null when the file is in place as asked,
 * else the reason. Root only: under any other user the folder is not trusted and nothing is written.
 */
export function applyBusinessDropIn(doc: Record<string, unknown> | null, p: DropInPaths = dropInPaths(), uid: number | null = ownUid(), owner = 0): string | null {
  const problem = dropInFolderProblem(p, uid, owner);
  const file = path.join(p.dir, BUSINESS_DROPIN_FILE);
  if (doc === null) {
    if (problem) return null; // nothing of ours can be there
    try { fs.rmSync(file, { force: true }); } catch (e) { return `could not remove ${file}: ${(e as Error).message}`; }
    return null;
  }
  if (problem) return problem;
  // One file for the whole box: a thread that starts while another one's set is written must still find
  // its own servers, so the allow-list only grows while the profile stays business.
  const before = readIfOwned(file, owner);
  let merged = doc;
  if (before) {
    try {
      const old = JSON.parse(before) as { allowedMcpServers?: unknown };
      const now = Array.isArray(doc.allowedMcpServers) ? doc.allowedMcpServers : [];
      const prior = Array.isArray(old.allowedMcpServers) ? old.allowedMcpServers : [];
      const seen = new Set(now.map((e) => JSON.stringify(e)));
      merged = { ...doc, allowedMcpServers: [...now, ...prior.filter((e) => !seen.has(JSON.stringify(e)))] };
    } catch { /* an unreadable file is replaced */ }
  }
  const text = `${JSON.stringify(merged, null, 2)}\n`;
  try {
    if (readIfOwned(file, owner) === text) return null;
    // A dot name while it is written: Claude Code reads only `*.json` and skips hidden files.
    const tmp = path.join(p.dir, `.${BUSINESS_DROPIN_FILE}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, text, { mode: 0o644 });
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, file);
  } catch (e) { return `could not write ${file}: ${(e as Error).message}`; }
  return readIfOwned(file, owner) === text ? null : `${file} did not hold what was written`;
}

function readIfOwned(file: string, owner: number): string | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.uid !== owner || (st.mode & 0o022) !== 0) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

/** The names of the MCP servers an init frame reports (names only), or null when it has no list. */
export function initServerNames(event: unknown): string[] | null {
  const list = (event as { mcp_servers?: unknown } | null)?.mcp_servers;
  if (!Array.isArray(list)) return null;
  return list.map((m) => (m && typeof m === 'object' ? String((m as { name?: unknown }).name ?? '') : String(m))).filter(Boolean);
}

/**
 * Built-in tools a hosted thread must not have: the Artifact tools (Artifact, ArtifactComments,
 * ArtifactData) publish to the person's claude.ai account, outside the platform. Off by the image's
 * managed policy (`enableArtifact: false`, `disableArtifact: true`) and by CLAUDE_CODE_ARTIFACT=0.
 */
export function forbiddenInitTools(event: unknown): string[] {
  const tools = (event as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter((t): t is string => typeof t === 'string' && /^Artifact/.test(t));
}

/** How Claude Code spells a server name inside a tool name (`mcp__<server>__<tool>`). */
const toolServerSpelling = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * MCP tools in the init frame's `tools` whose server Dispatch did not pass: a connector can show
 * its tools there without being in `mcp_servers` (`mcp__claude_ai_Gmail__send_message`). A tool of an
 * expected server is never flagged (the check is by server name; a server's own tool list is not).
 */
export function unexpectedInitMcpTools(expected: readonly string[], event: unknown): string[] {
  const tools = (event as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return [];
  const ok = new Set(expected.map(toolServerSpelling));
  return tools.filter((t): t is string => {
    if (typeof t !== 'string') return false;
    const m = /^mcp__(.+?)__/.exec(t);
    return !!m && !ok.has(m[1]);
  });
}

/** The line a thread shows when its harness's init frame names no MCP server list at all. */
export const NO_SERVER_LIST_NOTICE = "This thread's agent program did not report which tools it loaded, so the workspace could not check them. "
  + 'Do not use tools you do not recognise for company data. Tell your administrator.';

/** The servers in `reported` that Dispatch did not pass. */
export function unexpectedServers(expected: readonly string[], reported: readonly string[]): string[] {
  const ok = new Set(expected);
  return reported.filter((n) => !ok.has(n));
}

/** The line a thread shows when its harness reports a server Dispatch did not pass. */
export function unexpectedServersNotice(names: readonly string[]): string {
  return `This thread's agent program loaded tools that the workspace did not give it: ${names.join(', ')}. `
    + 'Do not use them for company data. Tell your administrator.';
}
