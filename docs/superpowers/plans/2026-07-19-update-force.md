# Update Force Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A dirty working tree no longer silently blocks updates — the API reports exactly what's dirty, and `force: true` skips our clean-tree gate so `git pull --ff-only` itself decides.

**Architecture:** `preflightUpdate` gains a `force` option and returns parsed porcelain rows plus a `forceable` flag; the apply route passes `force` through from the JSON body; the update modal lists the dirty files and offers "Update anyway" when forceable.

**Tech Stack:** TypeScript ESM, vitest, Express, React.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-19-update-force-design.md`.
- `force` skips ONLY the dirty-tree gate. Fetch, branch resolution, and the fast-forward/ancestor check are never skipped.
- NEVER auto-stash (shared stash stack across worktrees).
- Wire compatibility: success and 409 shapes keep their existing fields; new fields are additive.
- Dirty entries capped at 50; report the overflow count.
- Core tests from `packages/core`, web tests from `packages/web` (`npx vitest run`), never the repo root.
- This Mac runs the user's real daemon: never run dispatch lifecycle commands, never trigger a real update.

---

### Task 1: preflight reports dirt, accepts force; route passes it through

**Files:**
- Modify: `packages/core/src/update/apply.ts` (PreflightResult, preflightUpdate)
- Modify: `packages/core/src/routes/update.ts:43-50` (apply handler)
- Test: `packages/core/tests/update/apply.test.ts`, `packages/core/tests/routes/update.test.ts` (extend both; follow their existing gitExec-faking patterns)

**Interfaces:**
- Produces: `parsePorcelain(status: string): { entries: {status:string;path:string}[]; overflow: number }` (exported for tests); `PreflightResult { ok, reason?, dirty?, dirtyOverflow?, forceable? }`; `preflightUpdate(repoDir, gitExec?, opts?: { force?: boolean })`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/tests/update/apply.test.ts — add to the existing describe
const DIRTY = ' M packages/core/src/server.ts\n?? scratch.txt\nR  old.ts -> new.ts\n';

test('dirty tree reports parsed entries and is forceable', () => {
  const git = (args: string[]) => (args[0] === 'status' ? DIRTY : '');
  const r = preflightUpdate('/repo', git);
  expect(r.ok).toBe(false);
  expect(r.forceable).toBe(true);
  expect(r.dirty).toEqual([
    { status: ' M', path: 'packages/core/src/server.ts' },
    { status: '??', path: 'scratch.txt' },
    { status: 'R ', path: 'old.ts -> new.ts' },
  ]);
});

test('force skips the dirty gate and proceeds to the ff check', () => {
  const calls: string[][] = [];
  const git = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'status') return DIRTY;
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main\n';
    if (args[0] === 'rev-parse') return 'abc123\n';
    return '';
  };
  const r = preflightUpdate('/repo', git, { force: true });
  expect(r.ok).toBe(true);
  expect(calls.some((c) => c[0] === 'fetch')).toBe(true);
});

test('divergence is not forceable', () => {
  const git = (args: string[]) => {
    if (args[0] === 'status') return '';
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main\n';
    if (args[0] === 'rev-parse') return 'abc\n';
    if (args[0] === 'merge-base') throw new Error('not an ancestor');
    return '';
  };
  const r = preflightUpdate('/repo', git, { force: true });
  expect(r.ok).toBe(false);
  expect(r.forceable).toBeFalsy();
});

test('parsePorcelain caps at 50 and counts the overflow', () => {
  const many = Array.from({ length: 60 }, (_, i) => `?? f${i}.txt`).join('\n');
  const { entries, overflow } = parsePorcelain(many);
  expect(entries).toHaveLength(50);
  expect(overflow).toBe(10);
});
```

Route test (extend `tests/routes/update.test.ts`, matching its existing app/gitExec setup):

```ts
test('409 carries the dirty list; force reaches apply', async () => {
  const applied: string[] = [];
  const gitExec = (args: string[]) => (args[0] === 'status' ? ' M a.ts\n' : '');
  const app = makeApp({ gitExec, applyFn: (d: string) => applied.push(d) });   // adapt to the file's helper
  const blocked = await request(app).post('/api/update/apply').send({});
  expect(blocked.status).toBe(409);
  expect(blocked.body.dirty).toEqual([{ status: ' M', path: 'a.ts' }]);
  expect(blocked.body.forceable).toBe(true);
  expect(applied).toHaveLength(0);
});
```
(plus a `force: true` case asserting `applied` receives the repo dir — note the gitExec must also answer the fetch/rev-parse/merge-base calls for the forced path to reach apply.)

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/core && npx vitest run tests/update/apply.test.ts tests/routes/update.test.ts`
Expected: FAIL (`parsePorcelain` not exported; `forceable`/`dirty` undefined).

- [ ] **Step 3: Implement**

In `apply.ts`:

```ts
export interface PreflightResult {
  ok: boolean;
  reason?: string;
  /** Parsed `git status --porcelain` rows, set only on a dirty-tree failure. */
  dirty?: { status: string; path: string }[];
  /** How many dirty rows were omitted past the 50-entry cap. */
  dirtyOverflow?: number;
  /** True when the dirty tree is the ONLY blocker — i.e. `force: true` would proceed. */
  forceable?: boolean;
}

const MAX_DIRTY_ENTRIES = 50;

/** `XY <path>` per row; rename rows keep `old -> new` as the path. */
export function parsePorcelain(status: string): { entries: { status: string; path: string }[]; overflow: number } {
  const rows = status.split('\n').filter((l) => l.trim().length > 0);
  const entries = rows.slice(0, MAX_DIRTY_ENTRIES).map((l) => ({ status: l.slice(0, 2), path: l.slice(3).trim() }));
  return { entries, overflow: Math.max(0, rows.length - MAX_DIRTY_ENTRIES) };
}

export function preflightUpdate(
  repoDir: string,
  gitExec?: GitExec,
  opts?: { force?: boolean },
): PreflightResult {
  const git = gitExec ?? makeGitExec(repoDir);

  let status: string;
  try {
    status = git(['status', '--porcelain']);
  } catch (err: any) {
    return { ok: false, reason: `git status failed: ${err.message}` };
  }
  if (status.trim().length > 0 && !opts?.force) {
    const { entries, overflow } = parsePorcelain(status);
    return {
      ok: false,
      reason: 'Working tree has uncommitted changes. Update anyway to let git decide — it refuses only if the update touches a file you changed.',
      dirty: entries,
      dirtyOverflow: overflow,
      forceable: true,
    };
  }
  // ...rest of the function unchanged (fetch, branch, heads, ancestor check)...
}
```

In `routes/update.ts` the apply handler becomes:

```ts
  router.post('/apply', (req, res) => {
    const force = req.body?.force === true;
    const result = preflightUpdate(repoDir, opts?.gitExec, { force });
    // ...existing 409/success branches unchanged; the 409 body already spreads `result`
    //    — if it hand-picks fields, add dirty/dirtyOverflow/forceable to the picked set...
  });
```

Read the existing handler and keep its response construction style; the only requirements are that `force` is honored and the new fields reach the client.

- [ ] **Step 4: Run tests** — the two files GREEN, then full core suite GREEN, `npx tsc -b` clean.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(update): report dirty files and allow forced updates"`

---

### Task 2: the modal shows what's dirty and offers "Update anyway"

**Files:**
- Modify: `packages/web/src/api/client.ts:232-235` (applyUpdate takes force, widened return type)
- Modify: `packages/web/src/components/update/useApplyUpdate.ts`
- Modify: `packages/web/src/components/update/UpdateModal.tsx`
- Test: `packages/web/src/components/update/UpdateModal.test.tsx` (extend)

**Interfaces:**
- Consumes: the 409 body from Task 1.
- Produces: `api.applyUpdate(force?: boolean)` returning `{ ok: boolean; reason?: string; dirty?: {status:string;path:string}[]; dirtyOverflow?: number; forceable?: boolean }`; `useApplyUpdate()` returning `{ apply, applying, failReason, failDirty, failDirtyOverflow, canForce, inProgress }` where `apply(force?: boolean)`.

- [ ] **Step 1: Failing tests** — in `UpdateModal.test.tsx`, following its existing api-mocking pattern: (a) when apply resolves `{ok:false, reason, dirty:[{status:' M',path:'a.ts'}], forceable:true}` the modal shows `a.ts` and an "Update anyway" button; (b) clicking it calls `api.applyUpdate` a second time with `true`; (c) when `forceable` is absent the button is NOT rendered.
- [ ] **Step 2: Run** `cd packages/web && npx vitest run src/components/update/UpdateModal.test.tsx` → FAIL.
- [ ] **Step 3: Implement**

```ts
// client.ts
applyUpdate: async (force?: boolean) => {
  const res = await fetch('/api/update/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(force ? { force: true } : {}),
  });
  return (await res.json()) as {
    ok: boolean; reason?: string;
    dirty?: { status: string; path: string }[]; dirtyOverflow?: number; forceable?: boolean;
  };
},
```

In `useApplyUpdate`, keep the existing shape and add state for the dirty list: `apply` becomes `async (force?: boolean)`, passes it to `api.applyUpdate(force)`, and on failure stores `res.dirty ?? null`, `res.dirtyOverflow ?? 0`, `res.forceable === true` alongside the reason (clearing all of them at the start of each attempt, exactly as `failReason` is cleared today).

In `UpdateModal`, where `failReason` renders today, add beneath it: the dirty entries as a monospace list (`{status} {path}`, `max-height` ~8 rows with `overflow-y:auto`), a `+N more` line when `dirtyOverflow > 0`, and — only when `canForce` — a secondary button labelled **Update anyway** wired to `apply(true)`, disabled while `applying`. Match the modal's existing button styling; do not restyle anything else.

- [ ] **Step 4: Run** the file, then the full web suite → GREEN.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(web): update modal lists dirty files and offers a forced update"`

---

## Self-Review (performed)

- **Spec coverage:** dirty reporting + cap → T1; force plumbing → T1; divergence-not-forceable → T1 tests; UI list + button → T2. No-auto-stash is satisfied by never adding stash code. Runtime verification deliberately omitted (spec says why).
- **Placeholders:** the route handler step says "keep its existing response construction style" — grounded in a checked-in file the implementer reads, not a TBD.
- **Type consistency:** `{ status, path }` entry shape and `forceable`/`dirtyOverflow` names identical in core, client, hook, and modal.
