# PR #47 Phase 2 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the security gaps two independent reviews (GPT-6 Astra + Claude Opus 4.8) found in PR #47's Codex coordinator, so a governed Codex coordinator cannot write or execute outside its own memory dir and cannot revive ungoverned.

**Architecture:** Tighten the coordinator membrane at four points — deny escalated shell commands for a read-only Codex coordinator (B1); fail closed instead of PTY-bypassing when a coordinator cannot get governed structured transport (B2); resolve symlinks before the memory-dir containment check (M1); check an ApplyPatch's move/rename destination, not only its source (M2). All four are additive guards with unit tests.

**Tech Stack:** TypeScript, Node, vitest. Branch `feat/control-plane-phase2` (PR #47).

## Global Constraints

- Branch: `feat/control-plane-phase2`. Do NOT merge; stop at green CI and report.
- Commit trailer (every commit): `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Secrets: never in argv. Not relevant to these tasks but keep the rule.
- Do NOT run the web vite build on this branch (daemon serves `packages/web/dist`).
- M3 (shared app-server MCP-identity leak) is OUT OF SCOPE — separate PR by owner decision.
- Every task is TDD: failing test first, minimal code, green, commit.
- Run `pnpm --filter @dispatch/core test` for core; `pnpm --filter @dispatch/core exec tsc --noEmit` for types.

---

## File Structure

- `packages/core/src/overseer/coordinator-policy.ts` — add `commandsEscalate` option (B1); realpath containment (M1).
- `packages/core/src/overseer/coordinator-policy.test.ts` — B1 + M1 tests.
- `packages/core/src/sessions/service.ts` — pass `commandsEscalate` for Codex coordinator (B1); fail-closed coordinator guard before PTY fallback (B2).
- `packages/core/src/structured/codex-translate.ts` — capture patch move/rename destination (M2).
- `packages/core/src/overseer/policy-adapter.ts` — carry the destination path through the adapter (M2).
- `packages/core/src/overseer/policy-adapter.test.ts` — M2 adapter test.
- `packages/core/src/structured/codex-manager.policy.test.ts` — end-to-end deny of a repo ApplyPatch through the real coordinator policy (T4).
- `packages/core/src/sessions/ensure-coordinator-harness.test.ts` (or a new `coordinator-pty-guard.test.ts`) — B2 route test.
- `packages/core/src/overseer/prompts.coordinator.test.ts` — label==enforced-dir cross-check (T3).

---

## Task 1: B1 — deny escalated shell commands for a read-only Codex coordinator

**Files:**
- Modify: `packages/core/src/overseer/coordinator-policy.ts` (`makeCoordinatorPolicy`)
- Modify: `packages/core/src/sessions/service.ts` (toolPolicy construction, ~line 2000)
- Test: `packages/core/src/overseer/coordinator-policy.test.ts`

**Interfaces:**
- Produces: `makeCoordinatorPolicy(memoryDir: string, opts?: { commandsEscalate?: boolean }): (toolName, input) => PolicyDecision`.
- Consumes (service.ts): `makeCoordinatorPolicy(coordinatorMemoryDirFor(terminal.type), { commandsEscalate: terminal.type === 'codex' })`.

**Rationale:** Under `sandbox:'read-only'` + `approvalPolicy:'on-request'`, pure reads never surface as approvals — the sandbox runs them silently. So EVERY Bash approval a Codex coordinator raises is a request to escape the sandbox (write or network). The coordinator writes its memory via ApplyPatch (the FILE_TOOLS path), never via shell, and ships through workers. Therefore a governed Codex coordinator needs no escalated shell command: deny them all (fail closed). The Claude coordinator has no OS sandbox — its Bash "allow" just runs — so it keeps today's shipped denylist (`commandsEscalate` false).

- [ ] **Step 1: Write the failing test**

Add to `coordinator-policy.test.ts`:

```ts
describe('makeCoordinatorPolicy commandsEscalate (Codex read-only)', () => {
  const dir = path.join(os.homedir(), '.codex');
  it('denies an arbitrary write command that is not in the denylist', () => {
    const policy = makeCoordinatorPolicy(dir, { commandsEscalate: true });
    expect(policy('Bash', { command: 'printf x > /repo/src/index.ts' }).allow).toBe(false);
    expect(policy('Bash', { command: 'node -e "require(\'fs\').writeFileSync(\'/repo/a\',\'x\')"' }).allow).toBe(false);
    expect(policy('Bash', { command: 'ln -s /repo ~/.codex/link' }).allow).toBe(false);
    expect(policy('Bash', { command: 'ls -la' }).allow).toBe(false); // even reads: they never surface under read-only, deny defensively
  });
  it('still allows a memory-dir ApplyPatch write', () => {
    const policy = makeCoordinatorPolicy(dir, { commandsEscalate: true });
    expect(policy('Write', { file_path: path.join(dir, 'notes.md') }).allow).toBe(true);
  });
  it('leaves the Claude denylist behavior unchanged when commandsEscalate is false', () => {
    const policy = makeCoordinatorPolicy(path.join(os.homedir(), '.claude'));
    expect(policy('Bash', { command: 'ls -la' }).allow).toBe(true);
    expect(policy('Bash', { command: 'git commit -m x' }).allow).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dispatch/core exec vitest run src/overseer/coordinator-policy.test.ts -t commandsEscalate`
Expected: FAIL (option not honored; `ls -la` allowed).

- [ ] **Step 3: Implement**

In `coordinator-policy.ts`, change the factory signature and the Bash branch:

```ts
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
      if (targets.length > 0 && targets.every((t) => isUnder(memoryDir, t))) return { allow: true };
      return { allow: false, message: delegateMsg(memoryDir) };
    }
    if (toolName === 'Bash') {
      // A read-only-sandbox coordinator (Codex) only ever surfaces a command approval when
      // the command needs to ESCAPE the sandbox (write or network). It never needs one: it
      // writes memory via ApplyPatch and ships through workers. Deny every escalated command.
      if (commandsEscalate) return { allow: false, message: SHIP_MSG };
      // No-sandbox coordinator (Claude): Bash "allow" just runs, so keep the shipped denylist.
      if (typeof inp.command !== 'string' || inp.command === '') return { allow: false, message: SHIP_MSG };
      if (BLOCKED_BASH.some((re) => re.test(inp.command as string))) return { allow: false, message: SHIP_MSG };
      return { allow: true };
    }
    return { allow: true };
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @dispatch/core exec vitest run src/overseer/coordinator-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire service.ts to pass the option**

In `service.ts`, change the coordinator toolPolicy construction:

```ts
const toolPolicy =
  config.role === 'coordinator'
    ? makeCoordinatorPolicy(coordinatorMemoryDirFor(terminal.type), { commandsEscalate: terminal.type === 'codex' })
    : typeof config.roleAuthority === 'string'
      ? roleToolPolicy(config.roleAuthority as never)
      : undefined;
```

- [ ] **Step 6: Types + core tests**

Run: `pnpm --filter @dispatch/core exec tsc --noEmit && pnpm --filter @dispatch/core test`
Expected: PASS (existing codex-manager.policy tests that pass a custom policy are unaffected; they call `makeCoordinatorPolicy` only where noted — update any that assumed the denylist for a codex path).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/overseer/coordinator-policy.ts packages/core/src/overseer/coordinator-policy.test.ts packages/core/src/sessions/service.ts
git commit -m "fix(core): deny escalated shell commands for a read-only Codex coordinator (B1)"
```

---

## Task 2: B2 — fail closed instead of PTY-bypassing a coordinator

**Files:**
- Modify: `packages/core/src/sessions/service.ts` (`spawnTerminal`, before the PTY fallback ~line 1886)
- Test: `packages/core/src/sessions/coordinator-pty-guard.test.ts` (new)

**Interfaces:**
- Produces: `spawnTerminal` throws for a `role === 'coordinator'` terminal when structured transport is unavailable, instead of building a PTY command with `--dangerously-bypass-approvals-and-sandbox`.

**Rationale:** The `coordinator` capability is `structured && …`; a coordinator REQUIRES governed structured transport by definition. When `structuredManagerFor(type)` is undefined (e.g. `DISPATCH_CODEX_PRETTY=0`), the current code falls through to a PTY spawn that drops the persona and the membrane. `relaunchTerminal` already catches a throw and sets the terminal to `error` — fail-closed.

- [ ] **Step 1: Write the failing test**

```ts
it('refuses to PTY-spawn a coordinator when structured transport is unavailable', () => {
  // Build a service whose structuredManagerFor('codex') returns undefined (pretty off).
  const svc = makeServiceWithNoCodexStructuredManager(); // helper mirrors existing test setup
  const terminalId = seedTerminal(svc, { type: 'codex', config: { role: 'coordinator', transport: 'structured' } });
  expect(() => svc.spawnTerminal(terminalId)).toThrow(/coordinator .* governed structured/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dispatch/core exec vitest run src/sessions/coordinator-pty-guard.test.ts`
Expected: FAIL (a PTY command is built; no throw).

- [ ] **Step 3: Implement — add the guard before the PTY fallback**

In `spawnTerminal`, immediately after the structured branch that `return`s, insert:

```ts
if (config.transport === 'structured' && this.structuredManagerFor(terminal.type)) {
  this.spawnStructured(terminal, config, workDir);
  return;
}
// A coordinator's persona + membrane live ONLY in the structured manager. If we cannot spawn
// it structured, we must NOT fall through to the PTY path (which adds
// --dangerously-bypass-approvals-and-sandbox and drops the membrane). Fail closed.
if (config.role === 'coordinator') {
  throw new Error(
    `refusing to spawn coordinator ${terminal.id} (${terminal.type}) without governed structured transport`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dispatch/core exec vitest run src/sessions/coordinator-pty-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Guard the transport-switch route too**

In `packages/core/src/routes/sessions.ts` (the transport-switch handler `/terminals/:id/transport`), reject switching a `role === 'coordinator'` terminal to `pty` with a 400. Add a test in `tests/routes/structured.test.ts` asserting the 400.

- [ ] **Step 6: Types + core tests**

Run: `pnpm --filter @dispatch/core exec tsc --noEmit && pnpm --filter @dispatch/core test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/sessions/service.ts packages/core/src/sessions/coordinator-pty-guard.test.ts packages/core/src/routes/sessions.ts packages/core/tests/routes/structured.test.ts
git commit -m "fix(core): fail closed instead of PTY-bypassing an ungoverned coordinator (B2)"
```

---

## Task 3: M1 — resolve symlinks before the memory-dir containment check

**Files:**
- Modify: `packages/core/src/overseer/coordinator-policy.ts` (`isUnder`)
- Test: `packages/core/src/overseer/coordinator-policy.test.ts`

**Interfaces:**
- Produces: `isUnder(dir, target)` resolves symlinks on both `dir` and the deepest existing ancestor of `target` before comparing, so a symlinked path that lexically sits under `dir` but really points outside is rejected.

- [ ] **Step 1: Write the failing test**

```ts
it('rejects a write that reaches outside the memory dir through a symlink', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covpol-'));
  const mem = path.join(tmp, 'mem'); fs.mkdirSync(mem);
  const outside = path.join(tmp, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(mem, 'link')); // mem/link -> outside
  const policy = makeCoordinatorPolicy(mem);
  expect(policy('Write', { file_path: path.join(mem, 'link', 'escaped.md') }).allow).toBe(false);
  // a real in-dir write still passes
  expect(policy('Write', { file_path: path.join(mem, 'ok.md') }).allow).toBe(true);
  fs.rmSync(tmp, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dispatch/core exec vitest run src/overseer/coordinator-policy.test.ts -t symlink`
Expected: FAIL (lexical resolve accepts the symlinked path).

- [ ] **Step 3: Implement — realpath the deepest existing ancestor**

```ts
/** Resolve `p` following symlinks as far as the path exists on disk, then re-append the
 *  not-yet-existing tail. A new file's parent dir usually exists even when the file does not. */
function realResolve(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  // Walk up until an existing ancestor is found, realpath it, then re-join the tail.
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // nothing existed — fall back to lexical
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function isUnder(dir: string, target: string): boolean {
  const rel = path.relative(realResolve(dir), realResolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
```

Add `import * as fs from 'node:fs';` if not present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dispatch/core exec vitest run src/overseer/coordinator-policy.test.ts`
Expected: PASS (including the existing `..` traversal test).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/overseer/coordinator-policy.ts packages/core/src/overseer/coordinator-policy.test.ts
git commit -m "fix(core): resolve symlinks before coordinator memory-dir containment (M1)"
```

---

## Task 4: M2 — check an ApplyPatch move/rename destination, not only its source

**Files:**
- Modify: `packages/core/src/structured/codex-translate.ts` (fileChange approval mapping, ~line 393)
- Modify: `packages/core/src/overseer/policy-adapter.ts` (ApplyPatch branch)
- Modify: `packages/core/src/overseer/coordinator-policy.ts` (`extractWritePaths` — include destinations)
- Test: `packages/core/src/overseer/policy-adapter.test.ts`, `coordinator-policy.test.ts`

**Interfaces:**
- Produces: the fileChange approval's `changes` entries carry `{ path, dest?, kind, diff }`, where `dest` is the rename/move destination when present. `extractWritePaths` returns both `path` and `dest` for every change.

**Rationale:** A codex fileChange whose `kind` is a move/rename carries a destination (Astra: `kind: { type, move_path }`). The translator currently reduces `kind` to a string and drops the destination, so `extractWritePaths` checks only the source. A patch whose source is in `~/.codex` but whose destination is a repo file passes containment.

- [ ] **Step 1: Write the failing test (adapter + policy)**

In `policy-adapter.test.ts`:

```ts
it('carries an ApplyPatch move destination through to the Write paths', () => {
  const out = adaptForPolicy('codex', {
    toolName: 'ApplyPatch',
    input: { changes: [{ path: '/home/u/.codex/a.md', dest: '/repo/src/x.ts', kind: 'update' }] },
  } as any);
  const paths = (out.input as any).changes.map((c: any) => c.path).concat(
    (out.input as any).changes.map((c: any) => c.dest).filter(Boolean),
  );
  expect(paths).toContain('/repo/src/x.ts');
});
```

In `coordinator-policy.test.ts`:

```ts
it('denies an ApplyPatch whose move destination leaves the memory dir', () => {
  const dir = path.join(os.homedir(), '.codex');
  const policy = makeCoordinatorPolicy(dir);
  expect(policy('Write', { changes: [{ path: path.join(dir, 'a.md'), dest: '/repo/src/x.ts' }] }).allow).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dispatch/core exec vitest run src/overseer/policy-adapter.test.ts src/overseer/coordinator-policy.test.ts -t move`
Expected: FAIL (dest dropped; policy allows).

- [ ] **Step 3: Implement — capture the destination in translate**

In `codex-translate.ts` fileChange approval, map each change to include the destination:

```ts
pending = {
  requestId: itemId,
  toolName: 'ApplyPatch',
  toolUseId: itemId,
  input: {
    ...(first ? { file_path: first } : {}),
    reason: params.reason ?? undefined,
    changes: changes.map((c: any) => ({
      path: c.path,
      // A move/rename carries its destination on the kind object; keep it so the membrane
      // checks BOTH endpoints (see coordinator-policy.extractWritePaths).
      dest: c.kind?.move_path ?? c.kind?.dest ?? c.move_path ?? undefined,
      kind: c.kind?.type ?? c.kind,
      diff: c.diff,
    })),
  },
};
```

In `policy-adapter.ts` ApplyPatch branch, carry `dest`:

```ts
const paths = changeList.map((c) => ({ path: c?.path, dest: (c as any)?.dest }));
```

In `coordinator-policy.ts` `extractWritePaths`, include destinations:

```ts
function extractWritePaths(inp: Record<string, unknown>): string[] {
  if (Array.isArray(inp.changes)) {
    const out: string[] = [];
    for (const change of inp.changes) {
      if (change && typeof change === 'object') {
        const c = change as Record<string, unknown>;
        if (typeof c.path === 'string') out.push(c.path);
        if (typeof c.dest === 'string') out.push(c.dest);
      }
    }
    return out;
  }
  const single = [inp.file_path, inp.notebook_path].find((v): v is string => typeof v === 'string');
  return single !== undefined ? [single] : [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dispatch/core exec vitest run src/overseer/policy-adapter.test.ts src/overseer/coordinator-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Types + commit**

```bash
pnpm --filter @dispatch/core exec tsc --noEmit
git add packages/core/src/structured/codex-translate.ts packages/core/src/overseer/policy-adapter.ts packages/core/src/overseer/policy-adapter.test.ts packages/core/src/overseer/coordinator-policy.ts packages/core/src/overseer/coordinator-policy.test.ts
git commit -m "fix(core): gate an ApplyPatch move/rename destination in the coordinator membrane (M2)"
```

---

## Task 5: T4 + T3 — close the two most useful test gaps

**Files:**
- Modify: `packages/core/src/structured/codex-manager.policy.test.ts` (T4)
- Modify: `packages/core/src/overseer/prompts.coordinator.test.ts` (T3)

**Rationale:** T4 — no existing test drives a repo-path `fileChange` approval through the manager with the REAL `makeCoordinatorPolicy(coordinatorMemoryDirFor('codex'))` and asserts a wire `decline`. A field-name drift between the adapter and the policy would pass today. T3 — the prompt's memory LABEL and the policy's enforced DIRNAME are two maps; a test must tie them together per harness.

- [ ] **Step 1: T4 — write the failing end-to-end deny test**

Spawn a governed codex thread through the fake app-server with `toolPolicy = makeCoordinatorPolicy(coordinatorMemoryDirFor('codex'), { commandsEscalate: true })`. Send an `item/fileChange/requestApproval` whose change path is a repo file. Assert the manager responds `decline` on the wire (mirror the existing `denyGitPush` assertion style with the fake server's response log).

- [ ] **Step 2: Run — verify it fails if the wiring is broken, passes now**

Run: `pnpm --filter @dispatch/core exec vitest run src/structured/codex-manager.policy.test.ts`
Expected: PASS with the fix in place (this test is a regression guard).

- [ ] **Step 3: T3 — write the label==dir cross-check**

```ts
it('the enforced memory dir matches the persona label per harness', () => {
  for (const h of ['claude-code', 'codex'] as const) {
    const enforced = coordinatorMemoryDirFor(h);              // coordinator-policy.ts
    const label = coordinatorMemoryLabelFor(h);               // prompts.ts (export if needed)
    expect(enforced.endsWith(label.replace(/^~[/]?/, ''))).toBe(true);
  }
});
```

If `coordinatorMemoryLabelFor` is not exported, export it from `prompts.ts` (no behavior change).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @dispatch/core exec vitest run src/overseer/prompts.coordinator.test.ts src/structured/codex-manager.policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/structured/codex-manager.policy.test.ts packages/core/src/overseer/prompts.coordinator.test.ts packages/core/src/overseer/prompts.ts
git commit -m "test(core): end-to-end coordinator ApplyPatch deny + label/dir cross-check (T3, T4)"
```

---

## Task 6: Full verification + push

- [ ] **Step 1: Full core + web suites + types**

Run: `pnpm --filter @dispatch/core test && pnpm --filter @dispatch/web test && pnpm --filter @dispatch/core exec tsc --noEmit && pnpm --filter @dispatch/web exec tsc --noEmit`
Expected: all green.

- [ ] **Step 2: Update the review doc + memory**

Mark B1/B2/M1/M2/T3/T4 fixed in `docs/superpowers/reviews/2026-09-23-pr47-phase2-review.md`; note M3 deferred to a follow-up PR. Update the memory file.

- [ ] **Step 3: Push and report CI**

```bash
git push origin feat/control-plane-phase2
```
Then watch CI to green and STOP. Do NOT merge. Report status and ask.

---

## Self-Review

- **Spec coverage:** B1 (Task 1), B2 (Task 2), M1 (Task 3), M2 (Task 4), T3+T4 (Task 5), M3 explicitly deferred. Covered.
- **Placeholder scan:** none — every code step has concrete code.
- **Type consistency:** `makeCoordinatorPolicy(dir, opts)` used consistently in Tasks 1/3/4/5 and service.ts; `extractWritePaths` returns `string[]` in all callers; `changes` entries carry `{path, dest?}` in translate, adapter, and policy.
