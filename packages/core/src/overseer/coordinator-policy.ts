// The daemon-enforced coordinator ground rules (see docs/superpowers/plans/2026-09-02-overseer-tuning.md,
// workstream C). Prompt text alone decays over a long session — the coordinator drifts from delegating
// to doing; this policy is consulted by the structured manager's can_use_tool membrane on every tool
// call, so the rule holds at turn 900 exactly as at turn 1. Deny messages teach: each one names the
// delegation the coordinator should do instead, so a denial redirects rather than dead-ends.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type PolicyDecision = { allow: true } | { allow: false; message: string };

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function delegateMsg(memoryDir: string): string {
  return (
    'Control Plane policy: coordinators never modify repo files themselves — spawn an implementer agent ' +
    `(spawn_agent) for this change. (Writes under ${memoryDir} — your own memory and plans — are allowed.)`
  );
}
const SHIP_MSG =
  'Control Plane policy: repo mutations and ship-shaped commands (git commit/push/merge, gh pr ' +
  'merge/create, gh workflow run, gh release, publish, dispatch update/release, terraform apply) are ' +
  'always delegated to an implementer agent — and merges/deploys/releases additionally need the ' +
  'human’s explicit go.';
const AGENT_MSG =
  'Control Plane policy: use spawn_agent (the dispatch MCP tool) instead of a native subagent, so the ' +
  'work is typed, visible in the Control Plane rail, and reviewable.';
function mcpMsg(allowed: readonly string[]): string {
  return (
    `Control Plane policy: this coordinator may call only the ${allowed.map((s) => `"${s}"`).join(', ')} MCP ` +
    'tools. Other MCP servers run outside your sandbox — spawn an agent (spawn_agent) for work that needs them.'
  );
}

// Native orchestration tools stripped from a coordinator's toolset at spawn time via
// --disallowedTools. The CLI auto-approves these without a can_use_tool request, so the
// membrane deny below never fires for them — removal at spawn is the only enforcement
// that actually reaches the model. The policy deny stays as a backstop for CLI versions
// or paths where the tools do surface a permission request.
export const COORDINATOR_DISALLOWED_TOOLS = ['Agent', 'Task', 'Workflow'];

// Tolerates a run of leading flags/options before the subcommand, including flags whose value
// is a separate token (`-C ../wt`, `-c user.email=x`, `-R owner/repo`), so an interposed flag
// can't be used to slip a blocked subcommand past the check.
const BLOCKED_BASH: readonly RegExp[] = [
  /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*(commit|push|merge|rebase|reset|cherry-pick|revert|tag)\b/,
  /\bgh\s+(?:-\S+(?:\s+\S+)?\s+)*pr\s+(?:-\S+(?:\s+\S+)?\s+)*(merge|create)\b/,
  /\bgh\s+(?:-\S+(?:\s+\S+)?\s+)*workflow\s+(?:-\S+(?:\s+\S+)?\s+)*run\b/,
  /\bgh\s+(?:-\S+(?:\s+\S+)?\s+)*release\b/,
  /\b(npm|pnpm|yarn)\s+(?:-\S+(?:\s+\S+)?\s+)*publish\b/,
  /\bdispatch\s+(update|release)\b/,
  /\bterraform\s+(apply|destroy)\b/,
];

/** Every path a file-write-shaped tool call touches: a single `file_path`/`notebook_path`,
 *  or (for the Codex ApplyPatch→Write adaptation) every `path` in a `changes` array. */
function extractWritePaths(inp: Record<string, unknown>): string[] {
  if (Array.isArray(inp.changes)) {
    const out: string[] = [];
    for (const change of inp.changes) {
      if (change && typeof change === 'object') {
        const c = change as Record<string, unknown>;
        // Both endpoints of a change count: the source `path` AND a move/rename `dest`. A patch
        // whose source sits in the memory dir but whose destination is a repo file must be denied,
        // so the destination has to be checked too (see codex-translate.ts's fileChange mapping).
        if (typeof c.path === 'string') out.push(c.path);
        if (typeof c.dest === 'string') out.push(c.dest);
      }
    }
    return out;
  }
  const single = [inp.file_path, inp.notebook_path].find((v): v is string => typeof v === 'string');
  return single !== undefined ? [single] : [];
}

/** Resolve `p` following symlinks as far as it exists on disk, then re-append the not-yet-existing
 *  tail. A new file's parent dir usually exists even when the file does not, so this catches a
 *  symlinked ancestor (e.g. `~/.codex/link -> /repo`) that a purely lexical resolve would miss.
 *  THROWS when a path component EXISTS but does not resolve — a dangling symlink or a symlink loop —
 *  rather than lexically re-appending past it (which would let `~/.codex/dangling -> /repo/x`
 *  resolve back "under" the memory dir). The caller (isUnder) fails closed on the throw. */
function realResolve(abs: string): string {
  // Callers pass an ABSOLUTE path (isUnder denies a relative target before it gets here).
  // Walk the ORIGINAL segments rather than path.resolve-ing them: path.resolve would fold `link/..`
  // to nothing BEFORE symlinks resolve, hiding a `link/../escape` traversal. (isUnder also rejects
  // any raw `..` segment outright, so this is a second line, not the only one.)
  if (!path.isAbsolute(abs)) throw new Error(`coordinator-policy: not an absolute path ${abs}`);
  const segs = abs.split(path.sep);
  const tail: string[] = [];
  for (let i = segs.length; i > 0; i--) {
    const prefix = segs.slice(0, i).join(path.sep) || path.sep;
    try {
      const real = fs.realpathSync(prefix);
      return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
    } catch (realErr: unknown) {
      // Only a clean ENOENT ("this prefix does not exist yet") lets us keep walking up. Any other
      // realpath error — EACCES, ELOOP (symlink loop), EIO, ENOTDIR — is NOT safely resolvable, so
      // fail closed rather than reconstruct an unchecked lexical path.
      if ((realErr as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw new Error(`coordinator-policy: unresolvable path (${(realErr as NodeJS.ErrnoException)?.code ?? 'unknown'}) ${prefix}`);
      }
      // ENOENT from realpath: does this exact prefix still EXIST on disk? A dangling symlink is
      // ENOENT to realpath but present to lstat (which does not follow the final link). If it
      // exists, it is dangling/unresolvable — fail closed instead of re-appending past it.
      let exists = false;
      let lstatErr: unknown = null;
      try { fs.lstatSync(prefix); exists = true; } catch (e) { lstatErr = e; }
      if (exists) throw new Error(`coordinator-policy: unresolvable path component ${prefix}`);
      if ((lstatErr as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw new Error(`coordinator-policy: unstattable path (${(lstatErr as NodeJS.ErrnoException)?.code ?? 'unknown'}) ${prefix}`);
      }
      tail.push(segs[i - 1]); // truly absent → keep walking up
    }
  }
  return abs; // nothing on the path existed — lexical absolute (won't be under an existing memoryDir)
}

/** True when `target` resolves to a path strictly inside the memory dir `rd` (not `rd` itself).
 *  `rd` is the memory dir's REAL path, resolved once when the policy is built (null when it could
 *  not be resolved — then nothing is under it). The target resolves through `realResolve`, so
 *  neither a traversal segment nor a symlinked ancestor can slip a path that only *textually*
 *  starts with the dir past the check. A RELATIVE target is denied: the harness would anchor it
 *  to the thread's cwd, not the daemon's, so resolving it here would check the wrong file (and a
 *  coordinator's memory path is always absolute anyway). Fails closed (false) when the target is
 *  unresolvable (dangling symlink / loop / EACCES). */
function isUnder(rd: string | null, target: string): boolean {
  if (rd === null) return false;
  if (!path.isAbsolute(target)) return false;
  // Reject ANY `..` segment in the raw target outright. After a symlink, `..` is resolved
  // differently by realpathSync (lexically, to the link's own parent) than by the kernel at write
  // time (to the link TARGET's parent), so `mem/link/../escape` can pass a realpath-based check yet
  // write OUTSIDE the memory dir. A coordinator's own memory path never needs `..`; deny it rather
  // than trust either resolution to agree with the eventual write.
  if (target.split(/[/\\]/).includes('..')) return false;
  let rt: string;
  try {
    rt = realResolve(target);
  } catch {
    return false;
  }
  const rel = path.relative(rd, rt);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** True when every entry of a `changes` array yields at least one string endpoint (source `path`
 *  or move `dest`). A change with neither is unverifiable — the membrane must fail closed rather
 *  than silently ignore it while approving the rest of the patch. */
function changesFullyCovered(inp: Record<string, unknown>): boolean {
  if (!Array.isArray(inp.changes)) return true;
  return inp.changes.every((c) => {
    if (!c || typeof c !== 'object') return false;
    const change = c as Record<string, unknown>;
    return typeof change.path === 'string' || typeof change.dest === 'string';
  });
}

/** Builds the ground rules for a coordinator thread's own tool use, scoped to `memoryDir` —
 *  the one directory a coordinator may write to (its own memory/plans). Pure — no I/O, no state.
 *
 *  `allowedMcpServers`, when set, is the only MCP servers whose tools (`mcp__<server>__<tool>`)
 *  the coordinator may call. An ordinary MCP server runs in its own process OUTSIDE the Codex
 *  sandbox (live-verified on codex-cli 0.156.1: a stdio server's tool wrote a file from a
 *  `read-only` thread), so for a sandboxed coordinator every other server — the user's
 *  config.toml servers (databricks, …) and Dispatch's integrations alike — is a way around the
 *  sandbox. (Codex's own `node_repl` is the exception: Codex runs it INSIDE the thread's sandbox —
 *  a write fails with EPERM — and asks no approval for it, so its calls never reach this policy.)
 *  Unset (the Claude coordinator, which has no sandbox to get around), MCP tools stay allowed. */
export function makeCoordinatorPolicy(
  memoryDir: string,
  opts: { commandsEscalate?: boolean; allowedMcpServers?: readonly string[] } = {},
): (toolName: string, input: unknown) => PolicyDecision {
  const commandsEscalate = opts.commandsEscalate === true;
  const allowedMcpServers = opts.allowedMcpServers;
  // Resolve the memory dir ONCE, here: a later swap of the dir (or an ancestor) for a symlink
  // cannot widen what the policy allows, and no tool call re-walks it. Unresolvable → null →
  // every file write is denied (fail closed).
  let resolvedMemoryDir: string | null;
  try { resolvedMemoryDir = realResolve(path.resolve(memoryDir)); } catch { resolvedMemoryDir = null; }
  return function coordinatorToolPolicy(toolName: string, input: unknown): PolicyDecision {
    const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (toolName === 'Agent' || toolName === 'Task' || toolName === 'Workflow') return { allow: false, message: AGENT_MSG };
    if (FILE_TOOLS.has(toolName)) {
      const targets = extractWritePaths(inp);
      // Fail closed unless EVERY change is verifiable (changesFullyCovered) AND every endpoint
      // resolves under the memory dir. A patch with an uncheckable change is denied whole.
      if (targets.length > 0 && changesFullyCovered(inp) && targets.every((t) => isUnder(resolvedMemoryDir, t))) return { allow: true };
      return { allow: false, message: delegateMsg(memoryDir) };
    }
    if (toolName === 'Bash') {
      // A read-only-sandbox coordinator (Codex: sandbox 'read-only' + 'on-request') only ever
      // surfaces a COMMAND approval when the command needs to ESCAPE the sandbox — a write or a
      // network call. Pure reads run silently under the sandbox and never reach the membrane. The
      // coordinator never needs an escalated command: it writes its memory through ApplyPatch (the
      // FILE_TOOLS path above) and ships through implementer agents. So deny EVERY escalated command
      // — a denylist would wave `printf > repo/f`, `tee`, `sed -i`, `node -e fs.writeFileSync`,
      // `ln -s`, `cp`, … straight through. Fail closed.
      if (commandsEscalate) return { allow: false, message: SHIP_MSG };
      // A no-sandbox coordinator (Claude) has no escalation gate — Bash 'allow' just runs the
      // command — so keep the shipped denylist (git commit/push, gh pr merge, publish, …).
      // Fail closed on a non-string/empty command: it isn't inspectable against BLOCKED_BASH.
      if (typeof inp.command !== 'string' || inp.command === '') return { allow: false, message: SHIP_MSG };
      if (BLOCKED_BASH.some((re) => re.test(inp.command as string))) return { allow: false, message: SHIP_MSG };
      return { allow: true };
    }
    // Server names come from Dispatch or the user's own config.toml — a coordinator cannot write
    // either (its memory dir excludes the Codex config), so matching the `mcp__<server>__` prefix
    // is enough.
    if (allowedMcpServers && toolName.startsWith('mcp__')) {
      if (allowedMcpServers.some((s) => toolName.startsWith(`mcp__${s}__`))) return { allow: true };
      return { allow: false, message: mcpMsg(allowedMcpServers) };
    }
    return { allow: true };
  };
}

// The directory (relative to the user's home, POSIX-style) each harness's coordinator uses for its
// own memory/plans — the ONE directory makeCoordinatorPolicy lets a coordinator write to. prompts.ts
// derives the label the persona shows the model from this same map (coordinatorMemoryRelDir), so
// what the model is TOLD and what the policy ENFORCES cannot drift apart.
//
// Codex gets a DEDICATED subdir, never the whole Codex home: ~/.codex also holds the CLI's own
// config.toml (notify / mcp_servers run commands outside the sandbox), rules/*.rules (execpolicy
// allow rules), the global AGENTS.md every Codex thread loads, skills, auth, and real git
// worktrees — a coordinator allowed to write there could rewrite its own guard rails or a repo.
// Claude keeps ~/.claude (Claude Code's own auto-memory lives in ~/.claude/projects/*/memory), and
// its coordinator has no OS sandbox to escape anyway (Bash runs under a denylist, not a sandbox).
// Falls back to '.claude' for any harness with no coordinator memory dir of its own.
const COORDINATOR_MEMORY_REL_DIR: Record<string, string> = {
  'claude-code': '.claude',
  codex: '.codex/dispatch-coordinator',
};

/** The per-harness coordinator memory dir, relative to the user's home (POSIX separators). */
export function coordinatorMemoryRelDir(harness: string): string {
  return COORDINATOR_MEMORY_REL_DIR[harness] ?? '.claude';
}

/** The per-harness coordinator memory dir, resolved to an absolute path under the user's home. */
export function coordinatorMemoryDirFor(harness: string): string {
  return path.join(os.homedir(), ...coordinatorMemoryRelDir(harness).split('/'));
}

/** Back-compat default: the Claude Code coordinator's memory dir. */
export const coordinatorToolPolicy = makeCoordinatorPolicy(coordinatorMemoryDirFor('claude-code'));
