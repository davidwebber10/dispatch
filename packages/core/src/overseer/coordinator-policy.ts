// The daemon-enforced coordinator ground rules (see docs/superpowers/plans/2026-09-02-overseer-tuning.md,
// workstream C). Prompt text alone decays over a long session — the coordinator drifts from delegating
// to doing; this policy is consulted by the structured manager's can_use_tool membrane on every tool
// call, so the rule holds at turn 900 exactly as at turn 1. Deny messages teach: each one names the
// delegation the coordinator should do instead, so a denial redirects rather than dead-ends.
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
    return inp.changes
      .map((change) => (change && typeof change === 'object' ? (change as Record<string, unknown>).path : undefined))
      .filter((v): v is string => typeof v === 'string');
  }
  const single = [inp.file_path, inp.notebook_path].find((v): v is string => typeof v === 'string');
  return single !== undefined ? [single] : [];
}

/** True when `target` resolves to a path strictly inside `dir` (not `dir` itself). Resolves
 *  both sides with `path.resolve` first, so a traversal segment like `..` can't slip a path
 *  that only *textually* starts with `dir` past a raw string-prefix check. */
function isUnder(dir: string, target: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Builds the ground rules for a coordinator thread's own tool use, scoped to `memoryDir` —
 *  the one directory a coordinator may write to (its own memory/plans). Pure — no I/O, no state. */
export function makeCoordinatorPolicy(memoryDir: string): (toolName: string, input: unknown) => PolicyDecision {
  return function coordinatorToolPolicy(toolName: string, input: unknown): PolicyDecision {
    const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (toolName === 'Agent' || toolName === 'Task' || toolName === 'Workflow') return { allow: false, message: AGENT_MSG };
    if (FILE_TOOLS.has(toolName)) {
      const targets = extractWritePaths(inp);
      if (targets.length > 0 && targets.every((t) => isUnder(memoryDir, t))) return { allow: true };
      return { allow: false, message: delegateMsg(memoryDir) };
    }
    if (toolName === 'Bash') {
      // Fail closed: a non-string (or empty) command isn't inspectable against BLOCKED_BASH,
      // so coercing it to '' and falling through to allow would let an uninspectable command
      // run ungoverned. Deny instead of guessing.
      if (typeof inp.command !== 'string' || inp.command === '') return { allow: false, message: SHIP_MSG };
      if (BLOCKED_BASH.some((re) => re.test(inp.command as string))) return { allow: false, message: SHIP_MSG };
      return { allow: true };
    }
    return { allow: true };
  };
}

// The dirname (under the user's home) each harness's coordinator uses for its own memory/plans —
// the one directory makeCoordinatorPolicy allows a coordinator to write to. Must name the same
// directory as prompts.ts's COORDINATOR_MEMORY_LABEL, which is what the persona TELLS the model;
// this is what the policy actually ENFORCES. Falls back to '.claude' for any harness with no
// coordinator memory dir of its own yet (today: every harness besides claude-code and codex —
// Phase 1 only ever creates claude-code coordinators, see service.ts's ensureCoordinator).
const COORDINATOR_MEMORY_DIRNAME: Record<string, string> = {
  'claude-code': '.claude',
  codex: '.codex',
};

/** The per-harness coordinator memory dir, resolved to an absolute path under the user's home. */
export function coordinatorMemoryDirFor(harness: string): string {
  return path.join(os.homedir(), COORDINATOR_MEMORY_DIRNAME[harness] ?? '.claude');
}

/** Back-compat default: the Claude Code coordinator's memory dir. */
export const coordinatorToolPolicy = makeCoordinatorPolicy(coordinatorMemoryDirFor('claude-code'));
