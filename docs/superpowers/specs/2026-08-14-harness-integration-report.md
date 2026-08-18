# Harness integration report — analytics + PTY usage capture vs. `agent-types.ts`

Branch `worktree-analytics-usage`, on top of merge commit `fc6ea25` (main's 23-commit
harness refactor, centred on `packages/core/src/providers/agent-types.ts`).

## 1. Re-pointed test: `pricing.test.ts`

**Where the spawnable model list now lives:** `packages/web/src/lib/harnesses.ts`,
exported as `HARNESSES` — an array of `{ id, label, type, provider, pretty, models }`,
one entry per harness (`claude`, `codex`, `grok`, `terminal`). This is the merge's
replacement for the old `const MODELS` map that used to live inline in
`NewThreadModal.tsx`; the modal now imports `HARNESSES` and reads `spec.models` off
the selected harness. `NewThreadModal.tsx` no longer contains a `MODELS` constant at
all, which is why the old regex scrape failed with its own "re-point this test"
message.

**How I re-pointed it:** `pricing.test.ts` now does a real dynamic import of
`harnesses.ts` instead of scraping source text:

```ts
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESSES_MODULE = path.resolve(HERE, '../../../web/src/lib/harnesses.ts');

async function spawnableFromHarnesses(): Promise<string[]> {
  const mod = (await import(HARNESSES_MODULE)) as HarnessesModule;
  return mod.HARNESSES.flatMap((h) => h.models.map((m) => m.model)).filter((m): m is string => m !== null);
}
```

Two things about the shape, both load-bearing:

- **Cross-package but real.** `harnesses.ts` (and the `types.ts` it imports) are
  plain TypeScript with no JSX/React runtime dependency, so vitest (vite-node) can
  load and execute the actual module — no scrape, no copy.
- **The import is dynamic with a non-literal specifier, not a static import.** I
  tried a static `import { HARNESSES } from '../../../web/src/lib/harnesses.js'`
  first; `tsc --noEmit` failed immediately with `TS6059: File ... is not under
  'rootDir'` — core's tsconfig scopes `rootDir` to `packages/core/src`, and a
  static import pulls the target file into the program for type-checking (and then
  for emit-path computation), which core's build correctly refuses to do outside its
  own tree. A dynamic `import(HARNESSES_MODULE)` where `HARNESSES_MODULE` is a
  *variable*, not a string literal, is invisible to TS's module resolution — the
  call gets typed as `Promise<any>` and the target module never joins the core
  program — so `tsc --noEmit` and `pnpm --filter dispatch-server build` are both
  clean, while vitest still resolves and runs the real file at test time.

**Proof the test still catches its target bug.** I temporarily added an unpriced
model to `HARNESSES` (`{ label: 'Grok Future', model: 'grok-future-unpriced' }`
under the Grok harness) and re-ran the test:

```
AssertionError: spawnable but unpriced — add a price or a documented exclusion: grok-future-unpriced
```

It failed exactly as designed, then I reverted the change. The property "every
spawnable-but-unpriced model must be a documented exclusion" is unchanged and at
full strength.

## 2. Capture dispatch: the strategy map shape

Two independent "capture dispatch" splits existed, matching the two bullets in the
task:

### a) Live PTY capture — `packages/core/src/analytics/pty-capture.ts`

The old code was:

```ts
if (terminal.type !== 'claude-code' && terminal.type !== 'codex') return;
if (provider === 'claude-code') { /* ~90 lines */ }
// provider === 'codex'
/* ~90 lines */
```

I extracted the two branches into standalone functions, `captureClaudeTurn(ctx)` and
`captureCodexTurn(ctx)` (byte-for-byte the same logic, just parameterized on a
`CaptureContext` instead of closed-over locals), and replaced the branch with a map:

```ts
export const PTY_CAPTURE_STRATEGY: Record<AgentType, ((ctx: CaptureContext) => void) | null> = {
  'claude-code': captureClaudeTurn,
  codex: captureCodexTurn,
  grok: null,
};
```

`attachPtyCapture`'s listener now does:

```ts
if (!isAgentType(terminal.type)) return;         // shell etc. — not a harness at all
const capture = PTY_CAPTURE_STRATEGY[terminal.type];
if (!capture) return;                             // e.g. grok — declared, deliberately no-op
capture({ db, terminalId, terminal, projectId, role, outcome, nowStr, priorState, onTurnClosed });
```

### b) History import — `routes/analytics.ts` + `importer.ts`

These two files cooperated on one operation (build the import list, then parse it)
using two separate hardcoded checks that had to stay in sync by hand. I moved both
the "where does this provider's transcript live" logic and the "how do you turn a
whole transcript into rows" logic into one new file,
`packages/core/src/analytics/history-import-strategy.ts`:

```ts
export interface HistoryImportStrategy {
  locateTranscript(terminal: TerminalRow, workingDir: string): string | undefined;
  importLines(db: Database.Database, thread: ImportThread, raw: string, cutoff: string): LineResult;
}

export const HISTORY_IMPORT_STRATEGY: Record<AgentType, HistoryImportStrategy | null> = {
  'claude-code': { locateTranscript: ..., importLines: importClaudeLines },
  codex: { locateTranscript: ..., importLines: importCodexLines },
  grok: null,
};
```

`importClaudeLines`/`importCodexLines` moved here verbatim from `importer.ts` (no
logic changes — same regex-free line-by-line parsing, same Codex running-total diff
with the same subagent-fork / negative-diff / cutoff guards, all comments intact).
`importer.ts` now just does `fs.readFileSync` + a map lookup + the safe-to-run-twice
bookkeeping; `routes/analytics.ts` does the map lookup to decide `transcriptPath`
instead of an inline `if (terminal.type === 'codex') ... else ...`.

**Why a `Record<AgentType, X | null>`, not two maps or a class hierarchy:** `Record`
over `AgentType` is exhaustive at compile time — TypeScript requires every key, so
forgetting an entry when a fourth harness is added is `TS2741: Property '...' is
missing`, not a silent `if` that falls through. `null` is a real value in the map
(present key, no behaviour), not an absent one — that's what makes Grok's exclusion
a declaration instead of a gap, and it's what the drift test below can actually
observe (`hasOwnProperty` vs. a missing key), which a plain `type is AgentType`
guard alone would not distinguish.

**Behaviour preserved exactly.** I kept one asymmetry deliberately: Claude's
`locateTranscript` in `history-import-strategy.ts` still guards on `workingDir`
before calling `resolveTranscriptPath` (`workingDir ? resolveTranscriptPath(...) :
undefined`), matching `routes/analytics.ts`'s original `if (workDir) transcriptPath =
...`. `pty-capture.ts`'s own Claude branch calls `resolveTranscriptPath` even with an
empty string (falls through to the cache/search path), which is a *pre-existing*
inconsistency between the live and backfill call sites that predates this change —
unifying it would have been an actual behaviour change to one of the two call sites,
which the task explicitly ruled out, so the two capture concerns (live vs. history)
stayed as two separate maps rather than one shared "locate" function.

The one behaviour that IS different, and is a strict improvement with zero
observable effect on any real thread: `importer.ts`'s dispatch used to be `t.provider
=== 'codex' ? codex : claude` — any provider string that was not literally `'codex'`
silently ran through the Claude parser. That's unreachable for Grok in practice
(`routes/analytics.ts` never resolves a `transcriptPath` for Grok, so it never builds
an `ImportThread` for it), and `importer.test.ts`'s one test that passes
`provider: 'grok'` directly hits a missing-file `readFileSync` failure before
dispatch is ever reached — so no existing test's behaviour changed. But a
hypothetical future non-Grok provider would previously have been silently
mis-parsed as Claude; now it is silently skipped (0 imported, 0 skipped) unless it
gets a declared strategy. Silently-skip-with-no-strategy is still not ideal, which
is exactly why part 3 makes "no strategy at all" a compile/test failure rather than
a route users can reach unnoticed.

## 3. Every hardcoded-provider hit, and my judgment

```
grep -rn "'claude-code'\|'codex'\|'grok'" packages/core/src/analytics packages/core/src/routes/analytics.ts
```

| Hit | File:line | Judgment |
|---|---|---|
| `HISTORY_IMPORT_STRATEGY` keys (`'claude-code'`, `codex`, `grok`) | `history-import-strategy.ts:~198-213` | Legitimate — the map's own keys, `Record<AgentType, ...>`. This is the "one place." |
| `PTY_CAPTURE_STRATEGY` keys | `pty-capture.ts:~275-278` | Legitimate — same reason. |
| `provider: 'claude-code'` / `provider: 'codex'` in the row objects written to `usage_turns` | `pty-capture.ts:137, 233` | Legitimate — inside `captureClaudeTurn`/`captureCodexTurn` respectively, each function IS the Claude-specific / Codex-specific implementation, so it names its own provider once, same as `queries.test.ts` fixtures naming a literal provider for a specific test row. Not a list. |
| Doc-comment prose quoting the old `if (type !== 'claude-code' && type !== 'codex')` and `t.provider === 'codex' ? ... : ...` | `pty-capture.ts`, `importer.ts` comments | Prose describing what was removed, for the next reader. Not code. |
| `queries.test.ts`, `startup.test.ts`, `recorder.test.ts`, `pty-wiring.test.ts`, `pty-capture.test.ts`, `importer.test.ts` fixture literals (`provider: 'claude-code'`, `provider: 'codex'`, `provider: 'grok'`, `makeTerminal('claude-code', ...)`) | throughout `*.test.ts` | Legitimate — test fixtures constructing specific rows/terminals to exercise specific behaviour, not a routing list. Left untouched. |
| `routes/analytics.ts`'s old `if (terminal.type === 'codex')` | removed | This WAS the seventh list (part of it) — replaced by the shared map lookup. |
| `importer.ts`'s old `t.provider === 'codex' ? codexLines : claudeLines` | removed | The other half of the same seventh list — replaced. |

I also checked the web side (`AnalyticsView.tsx` and friends): no hardcoded provider
strings there — the chart groups by whatever `provider` the API returns, so it was
already harness-agnostic and needed no change.

No other hardcoded provider list was found in the analytics feature.

## 4. The drift guard

New file: `packages/core/src/analytics/capture-drift.test.ts`, matching the shape of
`packages/core/tests/providers/agent-types.test.ts` (the existing "these two lists
cannot drift" guard: iterate `AGENT_TYPES`, assert presence in the other structure,
plus a size-match check for stray entries):

```ts
describe('every agent type has a declared PTY capture strategy', () => {
  it('pty-capture.ts', () => {
    for (const t of AGENT_TYPES) {
      expect(Object.prototype.hasOwnProperty.call(PTY_CAPTURE_STRATEGY, t), ...).toBe(true);
    }
  });
  it('history-import-strategy.ts (routes/analytics.ts + importer.ts)', () => { ... });
  it('neither map has a stray entry for a type that is not an agent type', () => {
    expect(Object.keys(PTY_CAPTURE_STRATEGY).sort()).toEqual([...AGENT_TYPES].sort());
    expect(Object.keys(HISTORY_IMPORT_STRATEGY).sort()).toEqual([...AGENT_TYPES].sort());
  });
});
```

`hasOwnProperty`, not a truthiness/`!!map[t]` check, so "declared `null`" (Grok, a
real pass) is distinguished from "key absent entirely" (a real failure).

**Proved it fails two ways**, then reverted both:

1. Removed the `grok: null,` line from `PTY_CAPTURE_STRATEGY` → `tsc --noEmit`:
   ```
   error TS2741: Property 'grok' is missing in type '{ 'claude-code': ...; codex: ...; }'
   but required in type 'Record<"claude-code" | "codex" | "grok", ...>'.
   ```
2. Same removal plus `as any` (to simulate a TS-bypassed drift, e.g. a stale
   `.d.ts` or a JS consumer) → `capture-drift.test.ts` fails both the
   `hasOwnProperty` test and the "no stray entry" test, with a clear diff showing
   `'grok'` missing from the received array.

Both mechanisms fire independently: the type system catches it in normal
development, the runtime test catches it even if someone works around the type
system.

## Verification output

**`pnpm --filter dispatch-server test`** — 147 files / 1441 tests, all passing (run
after the fix below). Confirmed the documented intermittent load-correlated flake:
one run showed 1 failure in an unrelated file, a second run (same code) showed 2
failures in different unrelated files, and immediate re-runs came back fully green
each time — consistent with the described flake, not a regression from this change.
The `install.test.ts` Grok-binary failures mentioned as a known-resolved baseline
issue did not appear in any run.

```
Test Files  147 passed (147)
     Tests  1441 passed (1441)
```

**`pnpm --filter dispatch-web test`** — found broken independent of this task: 2
suites (`AnalyticsView.test.tsx`, `AnalyticsView.colors.test.tsx`) failed with
`Failed to resolve import "recharts"`. Root cause: `packages/web/package.json` was
missing the `recharts` dependency entry (present in the pre-merge analytics branch's
`package.json` at commit `bc39030`, dropped during the main-branch merge's
`package.json` conflict resolution) even though `pnpm-lock.yaml` still had it and
`AnalyticsView.tsx` still imports it. This also explains the `pnpm-lock.yaml`
modification already showing in `git status` before I touched anything — a prior
`pnpm install` had partially reconciled the mismatch by stripping `recharts` back
out of the lockfile. Fixed with a one-line `package.json` addition
(`"recharts": "^3.10.1"`, matching the pre-merge version) plus `pnpm install`, which
restored `pnpm-lock.yaml` to exactly match the committed version (zero diff
afterward). After the fix:

```
Test Files  123 passed (123)
     Tests  989 passed (989)
```

**`tsc -b` (web)** — clean, no output.

**`pnpm --filter dispatch-server build`** — clean (`tsc` + copy `default-tools.json`).

**`node --input-type=module -e "await import('./packages/core/dist/server.js'); console.log('OK')"`**
→ `OK`.

**`pnpm --filter dispatch-web build`** — clean. Bundle output:

```
dist/assets/AnalyticsView-BBCozlSQ.js    417.65 kB │ gzip: 121.04 kB
dist/assets/index-D1Bt1KSH.js          2,407.16 kB │ gzip: 717.15 kB
```

Confirmed isolation directly: `grep -c recharts dist/assets/index-*.js` → `0`;
`grep -o recharts dist/assets/AnalyticsView-*.js | wc -l` → `83` (the library code,
correctly confined to its own lazy chunk).

## Files touched

- `packages/core/src/analytics/pricing.test.ts` — re-pointed to a real (dynamic,
  non-literal-specifier) import of `HARNESSES`.
- `packages/core/src/analytics/pty-capture.ts` — extracted `captureClaudeTurn` /
  `captureCodexTurn`, added `PTY_CAPTURE_STRATEGY`, dispatch now table-driven.
- `packages/core/src/analytics/history-import-strategy.ts` (new) — moved
  `importClaudeLines`/`importCodexLines` here, added `locateTranscript` per
  provider, added `HISTORY_IMPORT_STRATEGY`.
- `packages/core/src/analytics/importer.ts` — slimmed to orchestration only,
  dispatches via `HISTORY_IMPORT_STRATEGY`; re-exports `ImportThread` for API
  stability.
- `packages/core/src/routes/analytics.ts` — backfill-thread-list builder now uses
  `HISTORY_IMPORT_STRATEGY` instead of its own `if (terminal.type === 'codex')`.
- `packages/core/src/analytics/capture-drift.test.ts` (new) — the drift guard.
- `packages/web/package.json` — restored the missing `recharts` dependency
  (unrelated to the `agent-types` integration, found via the required verification
  step; `pnpm-lock.yaml` reconciled itself back to the committed version, no diff).
