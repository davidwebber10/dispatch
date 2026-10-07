// The daemon-enforced coordinator ground rules (see docs/superpowers/plans/2026-09-02-overseer-tuning.md,
// workstream C). Prompt text alone decays over a long session — the coordinator drifts from delegating
// to doing; this policy is consulted by the structured manager's can_use_tool membrane on every tool
// call, so the rule holds at turn 900 exactly as at turn 1. Deny messages teach: each one names the
// delegation the coordinator should do instead, so a denial redirects rather than dead-ends.
import os from 'node:os';
import path from 'node:path';
import {
  overseerMemoryDir, OVERSEER_MEMORY_ROOT_REL, ownMemoryFolderSafe, sharedMemoryFolderSafe, sharedProjectMemoryDir,
} from './memory-scope.js';
import { isUnder, realResolve } from './real-path.js';

export type PolicyDecision = { allow: true } | { allow: false; message: string };

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function delegateMsg(memoryDirs: readonly string[]): string {
  return (
    'Control Plane policy: coordinators never modify repo files themselves — spawn an implementer agent ' +
    `(spawn_agent) for this change. (Writes under ${memoryDirs.join(' and under ')} — your own memory and ` +
    'plans, and the project’s shared memory — are allowed.)'
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

/** Builds the ground rules for a coordinator thread's own tool use, scoped to `memoryDirs` —
 *  the only folders a coordinator may write to: its own memory/plans and the project's shared
 *  memory folder (see coordinatorWriteDirs; overseer memory scope spec 2026-10-07, Unit 2). A write
 *  passes when every path it touches is under one of them. Pure — no I/O, no state.
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
  memoryDirs: readonly string[],
  opts: { commandsEscalate?: boolean; allowedMcpServers?: readonly string[] } = {},
): (toolName: string, input: unknown) => PolicyDecision {
  const commandsEscalate = opts.commandsEscalate === true;
  const allowedMcpServers = opts.allowedMcpServers;
  // Resolve each memory dir ONCE, here: a later swap of a dir (or an ancestor) for a symlink
  // cannot widen what the policy allows, and no tool call re-walks it. Unresolvable → null →
  // nothing is under that dir (fail closed).
  const resolvedMemoryDirs = memoryDirs.map((dir): string | null => {
    try { return realResolve(path.resolve(dir)); } catch { return null; }
  });
  const underMemory = (target: string) => resolvedMemoryDirs.some((rd) => isUnder(rd, target));
  return function coordinatorToolPolicy(toolName: string, input: unknown): PolicyDecision {
    const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (toolName === 'Agent' || toolName === 'Task' || toolName === 'Workflow') return { allow: false, message: AGENT_MSG };
    if (FILE_TOOLS.has(toolName)) {
      const targets = extractWritePaths(inp);
      // Fail closed unless EVERY change is verifiable (changesFullyCovered) AND every endpoint
      // resolves under one of the memory dirs. A patch with an uncheckable change is denied whole.
      if (targets.length > 0 && changesFullyCovered(inp) && targets.every(underMemory)) return { allow: true };
      return { allow: false, message: delegateMsg(memoryDirs) };
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

// The directory (relative to the user's home, POSIX-style) that holds each harness's coordinator
// memory. prompts.ts derives the label the persona shows the model from this same map
// (coordinatorMemoryRelDir), so what the model is TOLD and what the policy ENFORCES cannot drift
// apart: every folder coordinatorWriteDirs gives a coordinator for its own memory lies under it.
//
// Claude: the root of the overseers' own memory folders, one per project
// (`<root>/<encoded project dir>/memory`, see memory-scope.ts). A Claude coordinator may write only
// to its own project's folder under it, not the whole root and not the rest of ~/.claude (which
// holds every other project's memory folder, the user's settings and CLAUDE.md).
//
// Codex gets a DEDICATED subdir, never the whole Codex home: ~/.codex also holds the CLI's own
// config.toml (notify / mcp_servers run commands outside the sandbox), rules/*.rules (execpolicy
// allow rules), the global AGENTS.md every Codex thread loads, skills, auth, and real git
// worktrees — a coordinator allowed to write there could rewrite its own guard rails or a repo.
// Falls back to the Claude root for any harness with no coordinator memory dir of its own.
const COORDINATOR_MEMORY_REL_DIR: Record<string, string> = {
  'claude-code': OVERSEER_MEMORY_ROOT_REL,
  codex: '.codex/dispatch-coordinator',
};

/** The per-harness coordinator memory dir, relative to the user's home (POSIX separators). */
export function coordinatorMemoryRelDir(harness: string): string {
  return COORDINATOR_MEMORY_REL_DIR[harness] ?? OVERSEER_MEMORY_ROOT_REL;
}

/** The per-harness coordinator memory dir, resolved to an absolute path under the user's home. */
export function coordinatorMemoryDirFor(harness: string): string {
  return path.join(os.homedir(), ...coordinatorMemoryRelDir(harness).split('/'));
}

/**
 * The memory folders of a coordinator of `projectDir` (overseer memory scope spec 2026-10-07,
 * Unit 2), under the home folder `home`:
 *   - own: Claude → its own memory folder (memory-scope.ts, keyed by `projectDir`, the working
 *     directory); Codex → ~/.codex/dispatch-coordinator (as before);
 *   - shared: this project's shared Claude memory folder, keyed by `sharedProjectDir`
 *     (claudeMemoryProjectDir of the working directory: the git repository's main root).
 * The shared folder is where a note for the user's own threads goes ("From the overseer:").
 *
 * A Claude own folder that resolves (through symlinks) outside ~/.claude/dispatch-overseer, or a
 * shared folder that resolves outside ~/.claude/projects, is null and listed in `refused`: a
 * symlink must not widen what the policy allows (review round 1).
 *
 * `sharedProjectDir` is null when the git resolution failed (claudeMemoryProjectDir): then the
 * shared folder is null and not listed in `refused`; the caller logs it (review round 2).
 */
export function coordinatorMemoryFolders(
  harness: string,
  home: string,
  projectDir: string,
  sharedProjectDir: string | null,
): { own: string | null; shared: string | null; refused: string[] } {
  const refused: string[] = [];
  const shared = sharedProjectDir === null ? null : sharedProjectMemoryDir(home, sharedProjectDir);
  const sharedOk = shared !== null && sharedMemoryFolderSafe(home, shared);
  if (shared !== null && !sharedOk) refused.push(shared);
  let own: string | null;
  if (harness === 'codex') {
    own = path.join(home, ...coordinatorMemoryRelDir('codex').split('/'));
  } else {
    own = overseerMemoryDir(home, projectDir);
    if (!ownMemoryFolderSafe(home, own)) { refused.unshift(own); own = null; }
  }
  return { own, shared: sharedOk ? shared : null, refused };
}

/** Every folder a coordinator may write to: the folders of coordinatorMemoryFolders that passed the checks. */
export function coordinatorWriteDirs(harness: string, home: string, projectDir: string, sharedProjectDir: string | null): string[] {
  const { own, shared } = coordinatorMemoryFolders(harness, home, projectDir, sharedProjectDir);
  return [own, shared].filter((dir): dir is string => dir !== null);
}
