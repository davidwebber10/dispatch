# Overseer Tuning (Fable Review Gates + Model Hygiene + Coordinator Ground Rules) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bake the Fable design/code-review gates into the Overseer, cut default-Opus waste with concrete model-economy guidance, and replace the dead-letter "no tools yourself" rule with daemon-enforced coordinator ground rules.

**Architecture:** Three stacked workstreams, one PR each. A: two new agent types (`design-reviewer`, `code-reviewer`) defaulting to the `fable` model tier, plus coordinator-prompt gate rules with skip criteria. B: coordinator-prompt orchestration tuning (teach `queue_agent`/`start_agent`, model-downgrade triggers, read-once discipline, initiative-level missions). C: a pure `coordinatorToolPolicy` module consulted by the structured manager's existing can_use_tool membrane — repo writes, ship-shaped Bash commands, and native subagents are denied with an instructive message, which survives long-context drift where prompt text does not.

**Tech Stack:** TypeScript, vitest (both packages). No new dependencies.

## Global Constraints

- Never run `pnpm --filter dispatch-web build` (vite build) on a feature branch — the running daemon serves `packages/web/dist`. Typecheck with `npx tsc -b` in `packages/web` instead.
- Commit trailers: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and the `Claude-Session:` link.
- Merge stacked PRs bottom-up with `--delete-branch` (GitHub retargets a PR to main only when its base branch is deleted).
- Stop at "PRs open, CI green" — merges and the release are separate per-action approvals.
- Model alias `fable` is valid for `claude --model` (see `packages/core/src/providers/claude-code.ts:24-26`).
- Prompt changes take effect only when a coordinator's claude process respawns (daemon restart or thread respawn) — note this in the release notes.
- Branch stack: `feat/overseer-review-gates` (A, from main) → `feat/overseer-orchestration-tuning` (B, from A) → `feat/overseer-coordinator-policy` (C, from B).

---

### Task A1: New agent types, personas, and fable model tier (core)

**Files:**
- Modify: `packages/core/src/overseer/prompts.ts` (AgentType union at ~line 128, `AGENT_PROMPTS` at ~163, `MODEL_FOR_TYPE` at ~213)
- Create: `packages/core/src/overseer/prompts.test.ts`

**Interfaces:**
- Produces: `AgentType` union gains `'design-reviewer' | 'code-reviewer'`; `AGENT_PROMPTS['design-reviewer']`, `AGENT_PROMPTS['code-reviewer']`; `MODEL_FOR_TYPE['design-reviewer'] === 'fable'`, `MODEL_FOR_TYPE['code-reviewer'] === 'fable'`. Tasks A2/A4 rely on these exact keys.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/overseer/prompts.test.ts
import { describe, expect, it } from 'vitest';
import { AGENT_PROMPTS, COORDINATOR_PROMPT, MODEL_FOR_TYPE, modelFor, systemPromptFor } from './prompts.js';

describe('fable review-gate agent types', () => {
  it('defines personas for design-reviewer and code-reviewer', () => {
    expect(AGENT_PROMPTS['design-reviewer']).toContain('Design Reviewer');
    expect(AGENT_PROMPTS['code-reviewer']).toContain('Code Reviewer');
  });

  it('routes both types to the fable model tier', () => {
    expect(MODEL_FOR_TYPE['design-reviewer']).toBe('fable');
    expect(MODEL_FOR_TYPE['code-reviewer']).toBe('fable');
    expect(modelFor({ agentType: 'design-reviewer' })).toBe('fable');
    expect(modelFor({ agentType: 'code-reviewer' })).toBe('fable');
  });

  it('systemPromptFor resolves the new personas', () => {
    expect(systemPromptFor({ agentType: 'design-reviewer' })).toBe(AGENT_PROMPTS['design-reviewer']);
    expect(systemPromptFor({ agentType: 'code-reviewer' })).toBe(AGENT_PROMPTS['code-reviewer']);
  });

  it('existing tiers are unchanged', () => {
    expect(MODEL_FOR_TYPE.coordinator).toBe('sonnet');
    expect(MODEL_FOR_TYPE.implementer).toBe('sonnet');
    expect(MODEL_FOR_TYPE.researcher).toBe('opus');
  });
});

describe('coordinator review gates', () => {
  it('the coordinator prompt teaches both gates and the skip criteria', () => {
    expect(COORDINATOR_PROMPT).toContain('design-reviewer');
    expect(COORDINATOR_PROMPT).toContain('code-reviewer');
    expect(COORDINATOR_PROMPT).toContain('SKIP both gates');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && npx vitest run src/overseer/prompts.test.ts`
Expected: FAIL — `AGENT_PROMPTS['design-reviewer']` is undefined (TS may refuse to compile the index first; that counts as the expected red).

- [ ] **Step 3: Implement**

In `packages/core/src/overseer/prompts.ts`:

```ts
export type AgentType = 'planner' | 'implementer' | 'researcher' | 'reviewer' | 'design-reviewer' | 'code-reviewer';
```

Append to `AGENT_PROMPTS` (keep the existing four entries untouched; reuse `AGENT_AUTONOMY_NOTE + AGENT_BROWSER_AUTH_NOTE`):

```ts
  'design-reviewer':
    'You are a Design Reviewer agent — the strongest model on the team, spent only at review gates. ' +
    'Review the assigned plan or design document BEFORE implementation begins: judge the architecture, ' +
    'the decomposition, the failure modes, the data/migration/rollback story, and what the plan misses. ' +
    'Read the referenced docs and the relevant code yourself — never review from the task description ' +
    'alone. Deliver: (1) a verdict — approve, approve-with-changes, or rework; (2) the specific changes ' +
    'required, ranked by risk; (3) the questions the plan leaves unanswered. Do not rewrite the plan ' +
    'and do not implement.' + AGENT_AUTONOMY_NOTE + AGENT_BROWSER_AUTH_NOTE,
  'code-reviewer':
    'You are a Code Reviewer agent — the strongest model on the team, spent only at review gates. ' +
    'Review the assigned diff or branch AFTER implementation and self-review are done: verify ' +
    'correctness, hidden failure modes, concurrency and edge cases, test adequacy (do the tests pin ' +
    'the behavior that matters?), and adherence to the approved plan. Read the actual diff and the ' +
    'surrounding code. Deliver: (1) a verdict — ship, fix-then-ship, or rework; (2) concrete findings ' +
    'with file:line references, ranked by severity; (3) what you verified and how. Do not rewrite the ' +
    'work yourself.' + AGENT_AUTONOMY_NOTE + AGENT_BROWSER_AUTH_NOTE,
```

Append to `MODEL_FOR_TYPE`:

```ts
  'design-reviewer': 'fable',
  'code-reviewer': 'fable',
```

Insert one bullet into `COORDINATOR_PROMPT`'s "How you operate" list, directly after the "Spawn proactively and early" bullet:

```ts
  '- REVIEW GATES (the strongest, most expensive model — spend it well): for NON-TRIVIAL code work, ' +
  'after a planner produces a plan or design doc, spawn a design-reviewer (point it at the doc paths ' +
  'and branch — never paste the doc) and ingest its verdict BEFORE spawning the implementer. After an ' +
  'implementer finishes and self-reviews a non-trivial change, spawn a code-reviewer on the branch/diff ' +
  'before the work is merged or reported done. SKIP both gates for: docs-only or copy changes, tiny ' +
  'diffs (roughly under 50 changed lines), routine chores (commits, status checks, memory writes), ' +
  'incident hotfixes the user wants NOW, and non-code work — there the ordinary reviewer type (or ' +
  'nothing) suffices. Never use design-reviewer/code-reviewer for analysis, planning, implementation, ' +
  'or routine review — researcher/planner/implementer/reviewer own that work.\n' +
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/core && npx vitest run src/overseer/prompts.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/overseer/prompts.ts packages/core/src/overseer/prompts.test.ts
git commit -m "feat(overseer): design-reviewer + code-reviewer agent types on the fable tier"
```

---

### Task A2: Teach the agency MCP server the new types

**Files:**
- Modify: `packages/core/src/overseer/agency-mcp.ts` (its own `AgentType` union at line 38; the `enum` arrays in the spawn_agent input schema at ~line 88 and the queue_agent schema at ~line 127+; the type-choice description at ~lines 79-80; the model-tier description at ~lines 104-107)

**Interfaces:**
- Consumes: the type names from Task A1 (string literals — agency-mcp keeps its own copy; it runs as a standalone node script).
- Produces: `spawn_agent`/`queue_agent` accept `agentType: 'design-reviewer' | 'code-reviewer'`.

- [ ] **Step 1: Make the edits**

Line 38:

```ts
export type AgentType = 'planner' | 'implementer' | 'researcher' | 'reviewer' | 'design-reviewer' | 'code-reviewer';
```

Both `enum` arrays (spawn_agent AND queue_agent input schemas):

```ts
enum: ['planner', 'implementer', 'researcher', 'reviewer', 'design-reviewer', 'code-reviewer'],
```

Extend the spawn_agent description sentence "researcher to investigate, planner to plan, implementer to build, reviewer to check" to:

```
researcher to investigate, planner to plan, implementer to build, reviewer to check, design-reviewer to gate a plan/design BEFORE implementation, code-reviewer to gate a finished diff before merge (both run the strongest model — reserve them for genuine review gates on non-trivial code work).
```

Extend the `model` property description's tier sentence to:

```
researcher, planner, and reviewer run on opus; implementer runs sonnet; design-reviewer and code-reviewer run fable (the strongest tier — never point them at routine work).
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/core && npx tsc --noEmit -p tsconfig.json` (or the package's build/typecheck equivalent; `pnpm --filter dispatch-server build` also typechecks — but do NOT run the web build).
Expected: clean. (agency-mcp has no test file and starts an MCP server at import — schema edits are covered by the typecheck plus Task A4's end-to-end check.)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/overseer/agency-mcp.ts
git commit -m "feat(overseer): agency MCP accepts design-reviewer / code-reviewer spawns"
```

---

### Task A3: Web rail knows the new types

**Files:**
- Modify: `packages/web/src/components/overseer/types.ts` (`AgentType` union line 10, `AGENT_TYPE` registry lines 32-37)
- Modify: `packages/web/src/components/overseer/live.ts` (`AGENT_TYPES` array line 38)
- Test: `packages/web/src/components/overseer/live.test.ts`

**Interfaces:**
- Consumes: type names from A1/A2.
- Produces: `AGENT_TYPE['design-reviewer'] = { icon: 'ph-ruler', label: 'design review' }`, `AGENT_TYPE['code-reviewer'] = { icon: 'ph-git-pull-request', label: 'code review' }`; `asAgentType('design-reviewer')` no longer falls back to `'implementer'`.
- NOTE: `DelegateModal.tsx` keeps its own four-chip list deliberately — the gates are coordinator-driven, not human-delegated.

- [ ] **Step 1: Write the failing test** (append to `live.test.ts`)

```ts
describe('fable review-gate agent types (web)', () => {
  it('terminalToAgentThread keeps design-reviewer / code-reviewer instead of falling back to implementer', () => {
    const t = (agentType: string): Terminal => ({
      id: `t-${agentType}`, sessionId: 's', type: 'claude-code', label: 'Gate',
      status: 'working', createdAt: '2026-09-02T12:00:00Z',
      config: { transport: 'structured', agentType },
    } as unknown as Terminal);
    expect(terminalToAgentThread(t('design-reviewer')).type).toBe('design-reviewer');
    expect(terminalToAgentThread(t('code-reviewer')).type).toBe('code-reviewer');
  });

  it('AGENT_TYPE has icon+label entries for both', () => {
    expect(AGENT_TYPE['design-reviewer']).toEqual({ icon: 'ph-ruler', label: 'design review' });
    expect(AGENT_TYPE['code-reviewer']).toEqual({ icon: 'ph-git-pull-request', label: 'code review' });
  });
});
```

Match the `Terminal` construction style already used in `live.test.ts` (reuse its existing terminal factory/helper if one exists rather than the inline cast above). Import `AGENT_TYPE` from `./types`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/web && npx vitest run src/components/overseer/live.test.ts`
Expected: FAIL — `terminalToAgentThread(...).type` is `'implementer'` (the asAgentType fallback) and `AGENT_TYPE['design-reviewer']` is undefined.

- [ ] **Step 3: Implement**

`types.ts` line 10:

```ts
export type AgentType = 'planner' | 'implementer' | 'researcher' | 'reviewer' | 'design-reviewer' | 'code-reviewer';
```

`AGENT_TYPE` registry — add:

```ts
  'design-reviewer': { icon: 'ph-ruler',            label: 'design review' },
  'code-reviewer':   { icon: 'ph-git-pull-request', label: 'code review' },
```

`live.ts` line 38:

```ts
const AGENT_TYPES: readonly AgentType[] = ['planner', 'implementer', 'researcher', 'reviewer', 'design-reviewer', 'code-reviewer'];
```

- [ ] **Step 4: Run the web suite + typecheck**

Run: `cd packages/web && npx vitest run && npx tsc -b`
Expected: all green, tsc clean. (Do NOT run the vite build.)

- [ ] **Step 5: Commit and open PR-A**

```bash
git add packages/web/src/components/overseer/types.ts packages/web/src/components/overseer/live.ts packages/web/src/components/overseer/live.test.ts
git commit -m "feat(overseer): web rail renders design-reviewer / code-reviewer types"
git push -u origin feat/overseer-review-gates
gh pr create --title "Overseer: Fable review gates (design-reviewer + code-reviewer)" --body "<summary per repo convention>"
```

---

### Task B1: Coordinator orchestration tuning (prompt only)

**Files:**
- Modify: `packages/core/src/overseer/prompts.ts` (`COORDINATOR_PROMPT` tool list and "How you operate" bullets)
- Test: `packages/core/src/overseer/prompts.test.ts` (extend)

**Interfaces:**
- Consumes: A1's prompt structure (B stacks on branch `feat/overseer-review-gates`).
- Produces: prompt text that A4/C2 leave untouched.

- [ ] **Step 1: Write the failing test** (append to `prompts.test.ts`)

```ts
describe('orchestration tuning', () => {
  it('teaches queue_agent and start_agent', () => {
    expect(COORDINATOR_PROMPT).toContain('queue_agent');
    expect(COORDINATOR_PROMPT).toContain('start_agent');
    expect(COORDINATOR_PROMPT).toContain('dependsOn');
  });
  it('teaches model economy and read-once discipline', () => {
    expect(COORDINATOR_PROMPT).toContain('MODEL ECONOMY');
    expect(COORDINATOR_PROMPT).toContain('read_agent ONCE');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/overseer/prompts.test.ts`
Expected: the two new tests FAIL.

- [ ] **Step 3: Implement — three edits to `COORDINATOR_PROMPT`**

(1) In the tool list, after the `spawn_agent` entry, add:

```ts
  '- queue_agent({ agentType, name?, task, mission?, dependsOn?, model? }) — like spawn_agent but QUEUED: ' +
  'the thread is created and waits. Pass dependsOn (an agentId) to auto-start it the moment that agent ' +
  'finishes. Use it to set up plan → design-review → implement → code-review chains up front instead of ' +
  'hand-holding every hand-off; you still read each stage’s output when its finish notice arrives.\n' +
  '- start_agent({ agentId }) — start a queued agent immediately (e.g. its dependency became irrelevant).\n' +
```

(2) Replace the tail of the WATCH bullet — the sentence "Act on it: call read_agent to ingest its full output, then decide the next step" becomes:

```
Act on it: call read_agent ONCE to ingest its full output, then decide the next step. Do not re-read an agent that has not finished another turn since your last read — repeated read_agent calls on an unchanged agent are pure token burn.
```

(3) After the REVIEW GATES bullet (from A1), add:

```ts
  '- MODEL ECONOMY: the per-type default model is often too big for the task. Pass model:"sonnet" ' +
  '(or "haiku") when you spawn: status checks and "did last night’s run work" sweeps, single-fact ' +
  'lookups and quick verifications, file/memory writes, git chores (commit, push, branch cleanup). ' +
  'Reserve the opus defaults for genuine investigation, planning, and judgment. If the user asks for ' +
  'the same check every day, suggest a scheduled run instead of re-spawning it by hand each night.\n' +
```

(4) Strengthen the MISSION bullet — after "Start a new mission only for genuinely separate initiatives." append:

```
Name missions at the INITIATIVE level (e.g. "Delta sync" covers its scoping, design review, and implementation) and do not let one catch-all mission absorb unrelated work.
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/core && npx vitest run src/overseer/prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit and open PR-B (base: `feat/overseer-review-gates`)**

```bash
git add packages/core/src/overseer/prompts.ts packages/core/src/overseer/prompts.test.ts
git commit -m "feat(overseer): coordinator orchestration tuning — queue_agent, model economy, read-once"
git push -u origin feat/overseer-orchestration-tuning
gh pr create --base feat/overseer-review-gates --title "Overseer: orchestration tuning (queue_agent, model economy, read-once)" --body "<summary>"
```

---

### Task C1: coordinatorToolPolicy pure module

**Files:**
- Create: `packages/core/src/overseer/coordinator-policy.ts`
- Create: `packages/core/src/overseer/coordinator-policy.test.ts`

**Interfaces:**
- Produces: `export type PolicyDecision = { allow: true } | { allow: false; message: string }` and `export function coordinatorToolPolicy(toolName: string, input: unknown): PolicyDecision`. Task C2 consumes exactly this signature.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/overseer/coordinator-policy.test.ts
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { coordinatorToolPolicy } from './coordinator-policy.js';

const memoryFile = path.join(os.homedir(), '.claude', 'projects', '-x', 'memory', 'MEMORY.md');

describe('coordinatorToolPolicy', () => {
  it('allows read-only tools unconditionally', () => {
    expect(coordinatorToolPolicy('Read', { file_path: '/repo/src/a.ts' })).toEqual({ allow: true });
    expect(coordinatorToolPolicy('Grep', { pattern: 'x' })).toEqual({ allow: true });
    expect(coordinatorToolPolicy('mcp__dispatch__spawn_agent', { agentType: 'implementer' })).toEqual({ allow: true });
  });

  it('allows file writes under ~/.claude (its own memory/plans)', () => {
    expect(coordinatorToolPolicy('Write', { file_path: memoryFile })).toEqual({ allow: true });
    expect(coordinatorToolPolicy('Edit', { file_path: memoryFile })).toEqual({ allow: true });
  });

  it('denies file writes anywhere else, with a delegate message', () => {
    const d = coordinatorToolPolicy('Edit', { file_path: '/Users/x/Developer/Projects/repo/src/app.ts' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.message).toContain('implementer');
    expect(coordinatorToolPolicy('Write', {}).allow).toBe(false); // no path → not provably safe
  });

  it('denies ship-shaped Bash commands', () => {
    for (const cmd of [
      'git commit -m "x"', 'git push origin main', 'cd /r && git merge feature',
      'gh pr merge 12', 'gh pr create --title x', 'gh workflow run deploy.yml -f environment=production',
      'gh release create v1', 'npm publish', 'pnpm publish', 'dispatch update', './bin/dispatch release 1.2.3',
      'terraform apply',
    ]) {
      expect(coordinatorToolPolicy('Bash', { command: cmd }).allow, cmd).toBe(false);
    }
  });

  it('allows read-only Bash', () => {
    for (const cmd of ['git status', 'git log --oneline -5', 'ls -la', 'rg -n pattern src/', 'gh pr checks 12', 'gh pr view 12']) {
      expect(coordinatorToolPolicy('Bash', { command: cmd }).allow, cmd).toBe(true);
    }
  });

  it('denies native subagents and points at spawn_agent', () => {
    const d = coordinatorToolPolicy('Agent', { prompt: 'go research' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.message).toContain('spawn_agent');
    expect(coordinatorToolPolicy('Task', {}).allow).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run src/overseer/coordinator-policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/core/src/overseer/coordinator-policy.ts
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

const BLOCKED_BASH: readonly RegExp[] = [
  /\bgit\s+(commit|push|merge|rebase|reset|cherry-pick|revert|tag)\b/,
  /\bgh\s+pr\s+(merge|create)\b/,
  /\bgh\s+workflow\s+run\b/,
  /\bgh\s+release\b/,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\bdispatch\s+(update|release)\b/,
  /\bterraform\s+(apply|destroy)\b/,
];

/** The ground rules for a coordinator thread's own tool use. Pure — no I/O, no state. */
export function coordinatorToolPolicy(toolName: string, input: unknown): PolicyDecision {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (toolName === 'Agent' || toolName === 'Task') return { allow: false, message: AGENT_MSG };
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run src/overseer/coordinator-policy.test.ts`
Expected: PASS (6).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/overseer/coordinator-policy.ts packages/core/src/overseer/coordinator-policy.test.ts
git commit -m "feat(overseer): coordinatorToolPolicy — daemon-enforced coordinator ground rules"
```

---

### Task C2: Wire the policy through the structured membrane

**Files:**
- Modify: `packages/core/src/structured/manager.ts` (LaunchOpts at ~line 85, Session at ~line 46, session creation at ~line 219, membrane at lines 243-276)
- Modify: `packages/core/src/sessions/service.ts` (`spawnStructured`, the escalate wiring at ~lines 1984-2000)

**Interfaces:**
- Consumes: `coordinatorToolPolicy` + `PolicyDecision` from C1.
- Produces: `LaunchOpts.toolPolicy?: (toolName: string, input: unknown) => PolicyDecision` (the manager stays generic — it never imports overseer code; the service passes the policy only for `config.role === 'coordinator'`).

- [ ] **Step 1: Manager edits**

Add to the `LaunchOpts` interface (next to `escalate?: boolean`):

```ts
  /** Optional per-session tool policy consulted before auto-allow; a deny is written straight
   *  back to the CLI with the policy's message (no pending, no human involvement). */
  toolPolicy?: (toolName: string, input: unknown) => { allow: true } | { allow: false; message: string };
```

Mirror the field on the `Session` interface and copy it at session creation (`toolPolicy: opts.toolPolicy` beside `escalate`).

In the membrane (after `const isAsk = …`, before the `if (session.escalate || isAsk)` branch):

```ts
        const denied = !isAsk && session.toolPolicy
          ? session.toolPolicy(typeof r?.tool_name === 'string' ? r.tool_name : '', r?.input)
          : null;
        if (denied && !denied.allow) {
          // Policy deny: answer the CLI immediately with the instructive message — the model
          // sees it as the tool result and can redirect (spawn an agent) within the same turn.
          this.write(terminalId, {
            type: 'control_response',
            response: { subtype: 'success', request_id: event.request_id, response: { behavior: 'deny', message: denied.message } },
          });
        } else if (session.escalate || isAsk) {
```

(The existing escalate/else branches are otherwise unchanged.)

- [ ] **Step 2: Service wiring**

In `spawnStructured`, beside the `escalate` computation (~line 1984):

```ts
    const toolPolicy = config.role === 'coordinator' ? coordinatorToolPolicy : undefined;
```

Pass `toolPolicy` in the manager `launch(...)` options object (~line 2000). Add the import:

```ts
import { coordinatorToolPolicy } from '../overseer/coordinator-policy.js';
```

Check whether `spawnStructured` is also the respawn/relaunch path (line ~1834 comment says relaunch re-applies the full wiring through it) — if any second launch call site exists, wire `toolPolicy` there identically.

- [ ] **Step 3: Typecheck + full core suite**

Run: `cd packages/core && npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: clean and green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/structured/manager.ts packages/core/src/sessions/service.ts
git commit -m "feat(overseer): structured membrane consults coordinatorToolPolicy for coordinator threads"
```

---

### Task C3: Ground-rules prompt text (replace the dead-letter ban)

**Files:**
- Modify: `packages/core/src/overseer/prompts.ts` (`COORDINATOR_PROMPT` opening line + final bullet)
- Test: `packages/core/src/overseer/prompts.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
describe('coordinator ground rules', () => {
  it('states the enforceable rule instead of the absolute ban', () => {
    expect(COORDINATOR_PROMPT).not.toContain('You do NOT write code, read files, or run tools yourself');
    expect(COORDINATOR_PROMPT).toContain('read-only');
    expect(COORDINATOR_PROMPT).toContain('denied at the tool layer');
  });
});
```

- [ ] **Step 2: Run to verify it fails**, then **Step 3: Implement**

Replace the opening line of `COORDINATOR_PROMPT`:

```ts
  'You are Control Plane — a coordinator. Your job is ORCHESTRATION: typed agents do the work. ' +
  'You may inspect directly — read files and run read-only commands (git status/log, ls, quick greps) — ' +
  'and you maintain your own memory files under ~/.claude. But you never modify a repository yourself: ' +
  'edits, commits, pushes, PRs, merges, releases, and deploys are ALWAYS delegated to an implementer ' +
  'agent, and anything that ships (merge/deploy/release) additionally needs the human’s explicit go. ' +
  'This is enforced — repo writes, ship-shaped commands, and native subagents are denied at the tool ' +
  'layer; when you hit a denial, spawn the right agent instead of retrying.\n\n' +
```

Replace the final bullet (`'- You never write code or edit files yourself — always delegate to an implementer agent.'`):

```ts
  '- Long sessions drift: the longer you run, the more tempting it becomes to just do the work yourself. ' +
  'Resist it — delegation IS the job. If you catch yourself editing repo files or running ship commands, ' +
  'stop and spawn an agent.';
```

- [ ] **Step 4: Run the prompts tests**

Run: `cd packages/core && npx vitest run src/overseer/prompts.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit and open PR-C (base: `feat/overseer-orchestration-tuning`)**

```bash
git add packages/core/src/overseer/prompts.ts packages/core/src/overseer/prompts.test.ts
git commit -m "feat(overseer): enforceable coordinator ground rules replace the dead-letter tool ban"
git push -u origin feat/overseer-coordinator-policy
gh pr create --base feat/overseer-orchestration-tuning --title "Overseer: daemon-enforced coordinator ground rules" --body "<summary>"
```

---

### Task D: Full verification + handoff

- [ ] **Step 1: Full suites on the C branch (the whole stack)**

Run: `cd packages/core && npx vitest run` then `cd packages/web && npx vitest run && npx tsc -b`
Expected: all green. Known flakes (pass in isolation): ThreadLabel typewriter, AnalyticsView, NewThreadModal waitFor.

- [ ] **Step 2: Report**

Report: 3 PRs open (A ← main, B ← A, C ← B), CI status per PR. Merge order when approved: A first, then B, then C, each with `--delete-branch`. Release note must say: prompt/policy changes reach a live coordinator only when its claude process respawns (daemon restart via `dispatch update`, or thread respawn); the web rail change is refresh-only.
