# Pretty mode: resume-from-summary prompt + lighter tool rows

**Date:** 2026-07-19
**Status:** Approved
**Branch:** `worktree-pretty-resume-and-tool-rows`

Two independent changes to the Pretty (structured / ChatView) surface. Part A is a
token-cost fix and ships first; Part B is presentation polish.

---

## Part A — Resume-from-summary prompt

### Problem

Resuming an old, large Claude Code session interactively shows a TUI dialog:

```
This session is 3d 4h old and 134k tokens.
Resuming the full session will consume a substantial portion of your usage limits.
We recommend resuming from a summary.

  1. Resume from summary (recommended)
  2. Resume full session as-is
  3. Don't ask me again
```

That dialog is an Ink component rendered only by the interactive app shell. Pretty
threads spawn with `-p` (see `claudeCodeProvider.buildStructuredCommand`), which never
runs that shell — so **every Pretty resume silently loads the full session**. This is the
exact usage-limit burn the dialog exists to prevent, and it is invisible to the user.

### Evidence

Decompiled from the Claude Code binary (v2.1.215). The gate:

```js
function Sdf(e, t) {
  if (!et("tengu_gleaming_fair", !1)) return null;
  if (bt().resumeReturnDismissed) return null;
  let r = Sae(process.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES, 70),
      n = Sae(process.env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD, 1e5),
      o = Date.now() - 60000,
      i = e.findLast((l) => (l.type === "user" || l.type === "assistant")
                            && Date.parse(l.timestamp) < o)?.timestamp;
  if (!i) return null;
  let s = (Date.now() - Date.parse(i)) / 60000;
  if (s < r) return null;
  let a = t(e);
  if (a < n) return null;
  return { sessionAgeMinutes: s, estimatedTokens: a };
}
```

And the action, which is the whole feature:

```js
if (pt === "never")   await pr((r) => ({ ...r, resumeReturnDismissed: !0 }));
if (pt === "compact") BJe.current("/compact", { ... });
```

"Resume from summary" is literally `/compact`. "Resume full session as-is" is a no-op.
Dispatch already has both halves of the plumbing: `IStructuredManager.compact()`
(`structured/manager.ts`, writes `/compact` on stdin) and
`POST /api/terminals/:id/compact` (`routes/terminals.ts`), both shipped in wave 6.

### Design

**Detection — new endpoint `GET /api/terminals/:id/resume-advice`**

Returns `{ shouldPrompt: boolean, ageMinutes: number, contextTokens: number }`.

Gate mirrors the CLI exactly:

- last user/assistant activity older than **70 minutes**
  (`CLAUDE_CODE_RESUME_THRESHOLD_MINUTES`)
- context over **100k tokens** (`CLAUDE_CODE_RESUME_TOKEN_THRESHOLD`)

Reading the same env vars keeps Pretty and the terminal in agreement — a user who has
tuned their thresholds gets one consistent behaviour across both surfaces.

Data sources, both already present in `sessions/cc-sessions.ts`:

- age — `transcriptTailStatus(workDir, sessionId).mtimeMs`
- size — the wave-6 context-fill figure: the last turn's
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`

The CLI estimates token count from message text. We use real usage numbers off the
transcript, so our figure is the true context size and strictly more accurate.

**Why REST rather than a ws event.** The structured ring's replay/hydration ordering is
delicate — the v2.4.0 history deadlock lived exactly there. A client-initiated fetch on
mount has no ordering coupling to replay and is straightforward to test.

**UI — dismissible card above the composer in `ChatView`**

Not a modal; nothing here needs to block. Shown only when `shouldPrompt` is true.

```
This session is 3d 4h old and 134k tokens.
Resuming the full session will consume a substantial portion of your usage limits.

  [ Resume from summary ]   Resume full session   Don't ask again
```

- **Resume from summary** → `POST /api/terminals/:id/compact`, then dismiss
- **Resume full session** → dismiss for this thread only. In-memory, keyed by terminal
  id, not persisted: the card is advice about *this* resume, so a later resume of the
  same thread (by then older and larger still) should ask again.
- **Don't ask again** → persisted global setting (`useSettings`), mirroring the CLI's
  `resumeReturnDismissed`; suppresses the card on every thread thereafter

The CLI additionally gates the whole dialog on a `tengu_gleaming_fair` feature flag. We
deliberately do not replicate that — it is Anthropic's own rollout control for the
feature, not a user preference, and reading it would couple us to an internal flag whose
absence should not silently disable a cost protection.

**Sequencing.** Compact must fire before the first message of the resumed session, which
is exactly when the card appears. Resuming loads history into the process but sends
nothing to the API until the user speaks; compacting first costs one summarization call
and leaves every later turn lean — identical economics to the CLI path.

`POST /compact` returns 409 without a live structured session. Opening a Pretty thread
runs `ensureStructuredAlive`, so by the time the card is actionable the session is live.
The handler still surfaces a 409 as an inline error rather than failing silently.

### Testing

- `resume-advice` gate: under/over each threshold, env-var overrides, missing transcript,
  thread with no `external_id` (→ `shouldPrompt: false`)
- card renders only when `shouldPrompt`
- each of the three actions: correct call, correct dismissal scope
- global dismissal suppresses across threads

---

## Part B — Lighter tool rows

### Problem

Every tool call renders as a bordered, `--color-elevated` box: caret, icon, name, and a
right-side `N lines` count. A turn that reads six files becomes six identical heavy
containers, drowning out the assistant's prose.

Only `Edit`/`MultiEdit`/`Write`, `TodoWrite`, `WebFetch`/`WebSearch`, and query-shaped
inputs get rich views (`toolviews/registry.tsx`). Bash, Read, Grep, Glob, Task and all
MCP tools fall through to a generic blue wrench plus raw JSON.

### B1 — Lighter rows (shared: `ToolCall`, both surfaces)

`ToolCall` is consumed by `ChatView` (Pretty) and `ConversationView` (read-only View mode
on CLI threads). Restyling it lands in both, keeping the surfaces consistent at no extra
cost.

- collapsed row drops `border` and `background: var(--color-elevated)`; both move to the
  expanded shelf only
- row renders `toolDetail` as a dimmed subject between name and status
- hover background on the row for affordance

No data change required. `toolTitle` already yields `Read auth.ts` for file tools and
`toolDetail` already carries the Bash command, grep pattern, or URL
(`conversation/transcript.ts`) — the row simply never rendered it.

Expanded behaviour, Input/Output tabs, and rich views are untouched.

### B2 — Run grouping (`ChatView.renderTimeline` only)

Two or more consecutive tool items sharing a `toolName` collapse into one row —
`Read 3 files · 145 l` — which expands to the individual calls.

Constraints, all already load-bearing in `renderTimeline`:

- `pageBoundaries` breaks a group. Without this a `loadOlder` prepend merges into an
  existing group and defeats scroll preservation.
- `AskUserQuestion` never groups; it has live-overlay special-casing.
- React key stays anchored to the group's **last** item, per the existing comment on
  group keying. Expansion state keys off the **first** member's `toolId`, which is
  immutable as a run grows.

**Streaming.** A group auto-expands while any member is still running, so live work stays
visible, then collapses once the whole run settles. A manual toggle wins permanently
thereafter — `useToolExpanded` already persists expansion per id across remounts.

**Scope.** Grouping stays out of `ConversationView`, which has its own separate render
loop. That is a clean follow-up, deliberately excluded here to keep the blast radius on
`renderTimeline` small.

### Testing

- three consecutive `Read`s render one row; expanding reveals three
- mixed tool names do not group
- a single tool call renders as a plain row, with no group chrome
- a `pageBoundaries` entry breaks a group
- a group with a running member renders expanded; collapses once all results land
- manual toggle survives a settle transition
- existing `ChatView` scroll-preservation tests still pass

---

## Risk

The riskiest surface is `renderTimeline`, whose grouping and React keys were tuned so
`loadOlder` prepends do not remount nodes and jump the reader's scroll position. Adding a
second grouping dimension on top is where a regression would hide. Mitigation: keep the
existing key discipline unchanged, break groups on page boundaries, and keep the existing
scroll-preservation tests green.

Part A touches no existing render path and carries materially less risk than Part B.
