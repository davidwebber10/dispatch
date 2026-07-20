# Thread board — a cross-project kanban keyed on "will this move without me?"

**Date:** 2026-07-20
**Status:** Design approved, spec pending review

A global board showing every thread across every project, bucketed by whether it
needs the human. Built in two phases, because the board is only as good as the
status signal underneath it and today that signal is wrong.

---

## The problem

Two problems, one of which is invisible.

**1. There is no single place to see what needs you.** Thread status exists only
per-project, scoped to that project's coordinator (`useRenderVals()` is hard-scoped to
`activeId`). Finding out whether anything needs you means visiting each project.

**2. A thread that asks you a question is filed as finished.** This is the one that
matters. `structured/manager.ts:240-251` handles turn-end with exactly two branches:

```js
if (lastToolUse is a wake-scheduler) emit('scheduled')
else                                 emit('idle')     // ← content-blind
```

It inspects `session.lastToolUse` and never the assistant's text. So an agent ending its
turn with *"…does that look right to you?"* takes the second branch. Then
`live.ts:128` maps `idle || done` → `'done'`, and the thread lands in the **Done**
bucket, styled identically to genuinely completed work.

`needs_input` has exactly three sources — a gated tool under supervision, an
`AskUserQuestion` call, or a keyword match on Claude Code's own notification text. A
plain-text question triggers none of them. There is no question-detection anywhere in
the codebase.

The status pipeline was built around *events the harness emits*. "The model asked you
something in prose" isn't an event, it's a property of content, and nothing in the
pipeline reads content. The gap is structural, not a missed case.

**Consequence for this feature:** a board over today's signal would be worse than the
current list, because a column boundary reads as authoritative. A thread in *Complete*
that actually needs you is more dangerous than the same thread in a flat list — you
stop scanning Complete entirely.

---

## The model

One question decides every card: **will this move without me?**

```
is it finished, and have I acknowledged it? ─ yes ──────→ RESTING
  │ no
will it act again WITHOUT me? ─ yes ───────────────────→ WORKING
  │ no
is it stopped BECAUSE it needs me? ─ yes ──────────────→ NEEDS HELP
  │ no  (finished, not yet acknowledged)
  └──────────────────────────────────────────────────→ COMPLETE
```

| Column | Meaning | Clears when |
| --- | --- | --- |
| **Needs Help** | No future activity until you engage. Ignore it and it stays frozen forever. | You answer |
| **Complete** | Finished, unacknowledged. | You check it off (opening the thread auto-checks) |
| **Working** | Future activity **not reliant on you**. Ignore it and it still progresses. | It finishes or asks |
| **Resting** | Acknowledged, or never started. Nobody is waiting. | — |

**Column order is by whose move it is:** the two you can clear on the left, the two you
can ignore on the right. Not lifecycle order — the only column that blocks on you must
be where the eye lands.

### Waiting is a sub-type of Working, not a column

Anything that will act once a condition is met is *in flight*. Working renders two
visual tiers:

- **live** — solid border, green dot, `● running · 4m · opus`
- **waiting** — dashed border, dimmed, under a `WAITING — RESUMES ON ITS OWN` divider:
  queued agents, scheduled/dormant threads, threads behind a dependency

Collapsing waiting into Working removes a decision the reader would otherwise make
constantly. As a separate column every dormant thread poses a question — *stalled or
scheduled?* As a sub-tier it poses none: the column already said it's handled.

### How cards move

Cards are never dragged; they move when the thread's reality changes.

| From | Event | To |
| --- | --- | --- |
| Needs Help | you answer | **Working** — the turn resumes |
| Needs Help | you dismiss an *inferred* ask (`✕`) | **Complete** — it had in fact finished |
| Complete | you open it, or check it off | **Resting** |
| Complete | you send it a message | **Working** |
| Resting | you send it a message | **Working** |
| Working | turn ends, declared `done` / undeclared | **Complete** |
| Working | turn ends asking, declared or inferred | **Needs Help** |
| any | you **Move to** (override) | the chosen column, until real activity |
| overridden | the thread emits any real activity | override cleared, derived status resumes |
| any | you archive the thread | leaves the board entirely |

Archived threads are not a column. They are already reachable through the existing
archived-threads surface and would otherwise swamp Resting.

### Manual override — the escape hatch

Every card offers **Move to** (⋯ on desktop, long-press on mobile). This is not a
convenience; it is the mitigation for this design's central risk. The status is derived,
derivation can be wrong, and without an override a mis-derived thread is *stuck* — most
acutely a thread left in **Working** by a daemon crash, which will never emit the
turn-end event that would free it.

**Only three targets are offered: Needs Help, Complete, Resting.**

`Working` is deliberately absent. The other three are *judgements* the human is entitled
to make — "this needs me", "this is done", "ignore this". Working is an **observed
fact**: a thread is running or it is not, and asserting it does not start it. Offering it
would let someone paint a dead thread green and then wonder why nothing happens. To
actually make a thread work you send it a message or press **Start** — real actions with
real effects.

This is the difference between a status *field* and a *derived* status. In Jira the board
is the truth and a card is wherever you put it. Here the board is a projection of what
threads are actually doing, so an override is not setting a value — it is correcting a
bad reading. That is also why free drag-and-drop stays out of scope: it would quietly
turn the board back into a lie.

**Real activity clears the override.** If a thread you marked Complete emits a turn an
hour later, it returns to Working, because it demonstrably *is* working. The override
corrected a stale signal; once a fresh signal exists the correction has done its job.

The alternative — a sticky override — was rejected because it recreates the original bug:
a thread that needs attention looking like it doesn't, with the human as the cause
instead of the heuristic. Nothing on this board should be able to permanently silence
itself.

### Complete is acknowledgement, not recency

A time window (e.g. 24h then age out) was considered and rejected: it drops things into
Resting whether or not you looked, so "I'll review it tomorrow" silently becomes "I never
saw it." Acknowledgement means **nothing leaves without you**, and Needs Help + Complete
together form a real to-do list that reaches zero.

Complete is not a duplicate of Resting. The distinguishing property is not recency but
whether *you have seen it*. Resting is the archive and never needs reading.

Mitigation for the chore risk: **opening a thread auto-acknowledges it** (you looked —
that is the acknowledgement), plus an explicit ☐ per card and a **Clear all** on the
column header.

---

## Phase 1 — make the status signal true

The board cannot be built first. Two mechanisms, in priority order.

### 1a. `report_status` — the agent declares where it landed

A tool every claude/codex thread receives, instructed in the system prompt to be called
at the end of every turn.

```
report_status({
  state:   "done" | "needs_you" | "blocked",
  summary: "one line — what happened",
  ask:     "the actual question"      // when needs_you
  blocker: "waiting on agent X"       // when blocked
})
```

Each declared state maps to exactly one column:

| `state` | Column | Notes |
| --- | --- | --- |
| `done` | **Complete** | Carries `summary` as the card's outcome line |
| `needs_you` | **Needs Help** | `ask` renders as the card's question |
| `blocked` | **Working**, waiting tier | `blocker` renders as `◌ behind "…"` |

`blocked` belongs in Working, not a column of its own: something waiting on another
agent *will* proceed without you, which is the definition of Working.

This is load-bearing for two reasons beyond accuracy:

- **Complete cannot be populated without it.** The daemon cannot distinguish "I finished
  the job" from "I'm sitting idle" — both are the same `idle` event. The declaration is
  the only signal that separates them.
- **It gives every card a real summary.** A board is only scannable if cards say
  something; today a card can show a thread name and a status dot. `summary` is what
  turns "Integrate wave 9 → main" into "✓ merged, 6 commits".

### 1b. Question heuristic — the backstop

Compliance with an instructed tool is high but never guaranteed, and the misses are
exactly today's failure: invisible. So turn-end gains a third branch, consulted only
when nothing was declared:

```
turn ends
  ├─ agent called report_status?     → use what it declared   (exact)
  ├─ last tool was a wake-scheduler? → scheduled
  ├─ final text looks like a question? → needs_help  (inferred, marked ~)
  └─ otherwise                        → complete
```

Match on the last assistant text: trailing `?`, and openers like *should I*, *do you
want*, *which*, *let me know*, *confirm*, *prefer*, *shall I*. Zero tokens, no model
dependency, no added latency.

**Inferred asks are marked, not hidden.** They sit in the same Needs Help column — one
place to look — but render dimmer with a `~` marker and a dismiss `✕`. This is the
honest degradation: the common case is exact, and the guess is *labelled as a guess*
rather than silently wrong. Neither mechanism alone gives that.

**Undeclared, non-question turns fall to Complete, not Resting** — the safe direction.
An unreviewed thing looks unreviewed rather than being filed away.

### 1c. Reconcile the status vocabularies

There are currently three, unaligned:

- persisted `terminals.status` — working / waiting / needs_input / error / queued / scheduled
- live `ThreadStatus` — starting / working / needs_input / idle / done / error / scheduled
- Overseer's render-time status — working / waiting / done / error / queued / scheduled

`'done'` is never persisted; it folds into `'waiting'`. The board needs one vocabulary
that survives a restart, so this phase defines the mapping explicitly rather than adding
a fourth.

---

## Phase 2 — the board

### Data

New cross-project aggregation. Nothing today spans projects — `useRenderVals()` is
scoped to `activeId` and coordinator fields are project-gated. This is a new data path,
not a new view over an existing one.

### Desktop

Four columns, `Needs Help · Complete · Working · Resting`, ordered by whose move it is.
Resting is deliberately the narrowest and quietest — it will hold the large majority of
threads (~94 of ~100 in the dispatch project alone) and is never meant to be read.

Cards carry: project tag, thread name, the declared `summary` or live state, and inline
actions (`Answer`, `Open`, `Start`, ☐).

### Mobile — first-class, not a fallback

**Stacked collapsible sections**, one vertical scroll:

- **Needs Help** and **Complete** expanded — the two that want you
- **Working** and **Resting** collapsed to a header and count

Swipeable columns were rejected: you cannot see that two threads need you without
swiping to find out, which defeats the board's purpose. A triage-only phone view was
also rejected as it abandons "first-class on both".

The board metaphor and the goal pull apart on a small screen. Columns exist to show
parallel state side-by-side — precisely what a phone cannot render. So mobile keeps the
**model** and drops the **metaphor**: sections carry the same information, and what is
lost is a visual convention rather than a capability. Every count is visible without
interaction, which is the one thing that matters when you pull out your phone to ask
*does anything need me?*

### Placement, and the view-mode setting

The two surfaces differ because only one of them is forced to choose.

**Desktop — no switch.** There is room for everything, so the board is simply another
pane you can open alongside a chat, rather than a mode that replaces your threads. It
opens in the `main` slot the same way any tab does, and can sit beside a running thread
in a split. Nothing about the existing desktop layout changes.

**Mobile — a two-mode picker**, in Settings → Appearance:

| Mode | What it is |
| --- | --- |
| **Threads** | Projects, then threads. The current mobile view. Default. |
| **Board** | The four sections, grouped by what needs you. |

A third *Inbox* mode (Needs Help + Complete only) was considered and cut: collapsing
Working and Resting inside Board already achieves it, and a mode that is another mode
with two sections hidden does not earn its own name.

**Each mode renders as a miniature of itself, not a labelled radio.** A 52px thumbnail
drawn in the mode's real colour language — Threads as a flat grey list, Board as
amber/blue/green/grey bands. Recognition rather than a symbol you have to learn. It also
enforces honesty: two modes whose thumbnails are hard to tell apart are two modes that
probably shouldn't both exist.

The setting is mobile-only and persists like the other `useSettings` preferences.

---

## Explicitly out of scope

- Free drag-and-drop between columns. The **Move to** override (above) is the sanctioned
  mechanism and is deliberately narrower — it offers three targets, not four, because
  Working is an observed fact rather than a judgement.
- Replacing the existing per-project Work rail. The board is additive; the rail stays.
- Replacing the existing mobile Threads view. It remains the default mode.
- A third *Inbox* mobile mode — Board with Working and Resting collapsed already is it.
- A desktop view-mode setting. Desktop opens the board as a pane; it never replaces.
- Any WIP limits, swimlanes, or sprint concepts. This is a status view, not a planning tool.

---

## Risks

**The heuristic will have false positives.** Rhetorical questions ("The real question is
whether…") will surface as inferred asks. Mitigated by the dismiss affordance and by
inferred cards being visually subordinate — but if the false-positive rate is high in
practice, Needs Help loses trust, which is the failure mode that matters most. Worth
measuring after Phase 1 before building Phase 2 on top.

**`report_status` compliance is unknown.** If models routinely skip it, Complete
under-populates and the heuristic carries more weight than intended. Phase 1 should be
observable — log declared-vs-inferred rates — before Phase 2 depends on it.

**Acknowledgement can become a chore.** If many threads complete at once, Complete
becomes a queue to clear. Auto-acknowledge-on-open and Clear-all are the mitigations; if
they prove insufficient the fallback is a time-based sweep as a secondary rule, not a
replacement.
