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
function realResolve(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
    } catch {
      // Does this component exist on disk (as a symlink/file/dir) even though realpath failed?
      // If so it's a dangling link or a loop — unresolvable, fail closed. `lstatSync` does not
      // follow the final symlink, so it succeeds for a dangling link where `realpathSync` threw.
      let componentExists = true;
      try { fs.lstatSync(cur); } catch { componentExists = false; }
      if (componentExists) throw new Error(`coordinator-policy: unresolvable path component ${cur}`);
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // nothing on the path existed — fall back to lexical
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when `target` resolves to a path strictly inside `dir` (not `dir` itself). Resolves BOTH
 *  sides through `realResolve` first, so neither a traversal segment like `..` nor a symlinked
 *  ancestor can slip a path that only *textually* starts with `dir` past the containment check.
 *  Fails closed (returns false) when either side is unresolvable (dangling symlink / loop). */
function isUnder(dir: string, target: string): boolean {
  let rd: string;
  let rt: string;
  try {
    rd = realResolve(dir);
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
 *  the one directory a coordinator may write to (its own memory/plans). Pure — no I/O, no state. */
export function makeCoordinatorPolicy(
  memoryDir: string,
  opts: { commandsEscalate?: boolean } = {},
): (toolName: string, input: unknown) => PolicyDecision {
  const commandsEscalate = opts.commandsEscalate === true;
  return function coordinatorToolPolicy(toolName: string, input: unknown): PolicyDecision {
    const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (toolName === 'Agent' || toolName === 'Task' || toolName === 'Workflow') return { allow: false, message: AGENT_MSG };
    if (FILE_TOOLS.has(toolName)) {
      const targets = extractWritePaths(inp);
      // Fail closed unless EVERY change is verifiable (changesFullyCovered) AND every endpoint
      // resolves under the memory dir. A patch with an uncheckable change is denied whole.
      if (targets.length > 0 && changesFullyCovered(inp) && targets.every((t) => isUnder(memoryDir, t))) return { allow: true };
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
