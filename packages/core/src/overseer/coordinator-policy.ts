// The daemon-enforced coordinator ground rules (see docs/superpowers/plans/2026-09-02-overseer-tuning.md,
// workstream C). Prompt text alone decays over a long session — the coordinator drifts from delegating
// to doing; this policy is consulted by the structured manager's can_use_tool membrane on every tool
// call, so the rule holds at turn 900 exactly as at turn 1. Deny messages teach: each one names the
// delegation the coordinator should do instead, so a denial redirects rather than dead-ends.
import os from 'node:os';
import path from 'node:path';

export type PolicyDecision = { allow: true } | { allow: false; message: string };

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const DELEGATE_MSG =
  'Control Plane policy: coordinators never modify repo files themselves — spawn an implementer agent ' +
  '(spawn_agent) for this change. (Writes under ~/.claude — your own memory and plans — are allowed.)';
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

/** The ground rules for a coordinator thread's own tool use. Pure — no I/O, no state. */
export function coordinatorToolPolicy(toolName: string, input: unknown): PolicyDecision {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (toolName === 'Agent' || toolName === 'Task' || toolName === 'Workflow') return { allow: false, message: AGENT_MSG };
  if (FILE_TOOLS.has(toolName)) {
    const target = [inp.file_path, inp.notebook_path].find((v): v is string => typeof v === 'string') ?? '';
    const claudeDir = path.join(os.homedir(), '.claude') + path.sep;
    if (target.startsWith(claudeDir)) return { allow: true };
    return { allow: false, message: DELEGATE_MSG };
  }
  if (toolName === 'Bash') {
    const cmd = typeof inp.command === 'string' ? inp.command : '';
    if (BLOCKED_BASH.some((re) => re.test(cmd))) return { allow: false, message: SHIP_MSG };
    return { allow: true };
  }
  return { allow: true };
}
