# Test-flakiness investigation — analytics branch

Investigation only. No production code was changed on the analytics branch. One
comment-only fix was committed (`2fd7bb9`), described at the end.

## Environment note (read this first)

This machine was under very heavy load for the whole investigation:

```
$ uptime
9:43  up 29 days, 23:10, 2 users, load averages: 91.25 49.42 26.14
```

16 physical CPUs, load average ~91. `git worktree list` at the time showed 7
other active agent worktrees on this same checkout besides this one and the
scratch probe. That means the flakiness this investigation is chasing is
happening on a host that is already 5-6x oversubscribed from unrelated work,
before this test suite's own parallelism is added on top. This context matters
for the verdict below.

## Experiment A — branch's current rate, full parallelism

`pnpm --filter dispatch-server test`, 5 runs, no exclusions.

| Run | Result | Extra failure beyond install.test.ts baseline |
|---|---|---|
| 1 | `Test Files 1 failed \| 133 passed (134)` / `Tests 2 failed \| 1279 passed` | none |
| 2 | same | none |
| 3 | same | none |
| 4 | same | none |
| 5 | same | none |

**A: 0/5 flakes.** Every run showed exactly the two known
`tests/setup/install.test.ts` baseline failures (the real `grok` binary at
`~/.local/bin/grok`) and nothing else. I could not reproduce the branch's
reported 2-of-4 extra-failure rate in this session.

## Experiment B — remove the added load, keep the runtime code

`npx vitest run` from `packages/core`, excluding the branch's 8 new test
files, 5 runs. Files confirmed new via `git log --diff-filter=A` /
`git diff --stat 944f527..HEAD` (all-insertion diffs, no prior history):

```
--exclude "src/analytics/frames.test.ts"
--exclude "src/analytics/importer.test.ts"
--exclude "src/analytics/pricing.test.ts"
--exclude "src/analytics/queries.test.ts"
--exclude "src/analytics/recorder.test.ts"
--exclude "src/analytics/startup.test.ts"
--exclude "src/db/usage.test.ts"
--exclude "src/routes/analytics.test.ts"
```

(`src/routes/state.test.ts` was excluded from this list — it already existed
at `944f527` and only gained additional cases on the branch, so it is not
"added load" in the sense the experiment means.)

| Run | Result | Extra failure beyond install.test.ts baseline |
|---|---|---|
| 1 | `Test Files 2 failed \| 124 passed (126)` / `Tests 3 failed \| 1208 passed` | **`tests/routes/terminals.test.ts` > `terminal routes > PATCH /api/terminals/:terminalId/auto-archive` > `defaults to 12 hours when no duration is given`** |
| 2 | `Test Files 1 failed \| 125 passed (126)` / `Tests 2 failed \| 1209 passed` | none |
| 3 | same as 2 | none |
| 4 | same as 2 | none |
| 5 | same as 2 | none |

**B: 1/5 flakes.**

The flake in run 1 is important: `terminals.test.ts`'s auto-archive test
creates a `type: 'shell'` terminal and PATCHes it. Shell terminals never touch
`structuredManager` — `attachUsageRecorder` only subscribes to
`structuredManager`'s `busy`/`event`/`idle`/`needs-help`/`scheduled`/`exit`
events (`packages/core/src/server.ts:150`), which a shell PTY never emits.
This test cannot invoke a single line of recorder code. Its failure is not
explained by the recorder hypothesis; it looks like generic host-contention
noise (a supertest/express round trip timing out under the ~91 load average),
unrelated to analytics.

## Experiment C — remove the runtime code, keep the load

Per protocol, since B showed a non-zero count, I continued to C. Scratch
worktree at `/Users/davidwebber/Sites/dispatch/.claude/worktrees/flake-probe`,
detached at branch HEAD (`f1b7578`), `pnpm install`'d there. Commented out the
`attachUsageRecorder(...)` call in that worktree's
`packages/core/src/server.ts` (all test files, including the 8 new ones,
still present):

```ts
  // FLAKE-PROBE: temporarily disabled for the flakiness investigation. Do not merge.
  // attachUsageRecorder(structuredManager, {
  //   db,
  //   onTurnClosed: () => broadcaster.broadcast({ type: 'analytics-dirty' }),
  // });
```

`npx vitest run` from that worktree's `packages/core`, 5 runs:

| Run | Result | Extra failure beyond install.test.ts baseline |
|---|---|---|
| 1 | `Test Files 1 failed \| 133 passed (134)` / `Tests 2 failed \| 1279 passed` | none |
| 2 | same | none |
| 3 | same | none |
| 4 | same | none |
| 5 | same | none |

**C: 0/5 flakes.**

Scratch worktree removed afterward (`git worktree remove ... --force` +
`git worktree prune`), confirmed clean via `git worktree list`.

## Verdict: indeterminate, weakly pointing away from the recorder

Rates: A 0/5, B 1/5, C 0/5. Five runs per cell (~1200-1280 tests each) is not
enough statistical power to separate a "true" flake rate anywhere from 0% to
perhaps 15-20% at 95% confidence, and I could not even reproduce the original
2-of-4 pattern once, let alone in the same two tests
(`structured.test.ts`, `auth.test.ts`) that were originally observed. The
single anomaly I did catch (B run 1) failed in a test that structurally
cannot reach the recorder's code path, which argues against the recorder
hypothesis rather than for it. Across the whole investigation the flaky test
was different every time it happened (`structured.test.ts`,
`auth.test.ts`, `terminals.test.ts` — three separate observations, three
separate tests), which is the signature of scheduler/host-contention noise,
not of one hot code path reliably tripping one consumer.

I did not get a clean A/B/C ladder where B stayed flaky and C went clean —
the data B produced doesn't cleanly implicate the runtime code in the first
place, so I can't respond "recorder confirmed" or "recorder killed" with
confidence either way. Calling this "indeterminate" rather than picking a
side is the honest read of what five runs on a ~91-load host produced.

## If the recorder were implicated (it wasn't, cleanly) — test artefact or production concern?

Answering this for completeness, since the hypothesis is plausible on its
face even though this run didn't confirm it: this would be a **test-environment
artefact**, not a production concern. `attachUsageRecorder`'s per-frame
`findOpenTurn` + `addUsage` is a synchronous SQLite read-modify-write against
one shared `better-sqlite3` connection (WAL mode,
`packages/core/src/db/connection.ts:6`). In production, one daemon process
handles one thread's frames at a time on ordinary hardware — the write-through
is cheap and serialized by construction, which is exactly the property the
design doc calls out as the point (mid-turn restart loses nothing). The test
suite, by contrast, spins up a dozen structured sessions concurrently across
parallel test files on a box that's already oversubscribed by unrelated
agent work, which is a load shape production never produces. So even in the
world where the recorder is the mechanism, it would be a scheduler/test-harness
concern, not a reason to change the recorder's design.

## Recommendation

Keep `--no-file-parallelism` (or an equivalent single-file-at-a-time mode) as
the CI-safe invocation for this suite for now — it was reported clean 100% of
the time and costs wall-clock time, not correctness. Do not change the
recorder's synchronous write-through design; nothing in this investigation
implicates it, and the design doc's own justification (no data loss on a
mid-turn restart) is a real production property worth keeping.

I would reject "add the recorder to an async/batched write queue" as a fix
right now — it would touch a deliberately-synchronous durability guarantee to
solve a problem this investigation could not pin on the recorder at all. If
the flake keeps recurring, the next productive step is a much larger sample
(20-30 runs per cell, ideally on a quiet host) rather than a code change made
on a hunch.

## Comment fix

`packages/core/src/analytics/pricing.test.ts` (around the `UNPRICED` map
comment) referenced `summary.unpricedTokens` and a `'partial'` badge, both
removed from the analytics surface in `f1b7578`. Reworded to describe only
what the test still checks (unpriced-but-spawnable models need a documented
exclusion). Comment-only change, committed separately as `2fd7bb9`
("docs(core): drop a stale pricing comment referencing removed fields").
