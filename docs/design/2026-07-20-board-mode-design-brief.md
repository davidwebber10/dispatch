# Design brief — Board mode (Dispatch)

You are improving a feature that already ships. It works; the model behind it is settled and
should not be re-litigated. What it needs is design judgement on presentation, density,
hierarchy, and a handful of unresolved states.

Read the "Settled" section as constraints, not suggestions — each line is a decision the
product owner reached by iterating on mockups, and several were arrived at by rejecting the
obvious alternative for a specific reason. The "Open" section is where you should spend your
effort.

---

## What Dispatch is

A workspace for running many AI coding agents at once. Each unit of work is a **thread** —
a live Claude Code or Codex session in a project directory. A user typically has **150–250
active threads across 15–20 projects**. Threads run unattended for long stretches; the
central problem is knowing which ones need the human and which are fine.

Threads render in one of two transports: **Pretty** (a structured chat view) or **CLI** (a
real terminal). Roughly 40% are CLI.

## What Board mode is

A second top-level view, alternative to the normal project-tree-and-tabs workspace. It
answers exactly one question per thread:

> **Will this move without me?**

That test produces four columns, ordered by *whose move it is* — the two you can clear on
the left, the two you can ignore on the right:

| Column | Meaning | Clears when |
| --- | --- | --- |
| **Needs Help** | Nothing happens until the human engages. Ignore it and it stays frozen forever. | They answer |
| **Complete** | Finished, unacknowledged. | They check it off (opening the thread also counts) |
| **Working** | Proceeds without them. Two tiers: **live** (running now) and **waiting** (queued, scheduled, or blocked behind another agent). | It finishes or asks |
| **Resting** | Acknowledged, or never started. The archive. | — |

Only **one** column can ever block on the human, which is the property that makes the board
scannable: you can ignore three quarters of it. The Needs Help count *is* the to-do list.

---

## Settled — do not redesign these

Each of these was chosen over a plausible alternative for a stated reason.

- **Four columns, that order.** Not lifecycle order. The one column that blocks on you must
  be where the eye lands first.
- **Waiting is a sub-tier of Working, not its own column.** A separate column would make
  every dormant thread pose a question ("stalled, or scheduled?"). As a tier it poses none —
  the column already said it's handled.
- **Complete is acknowledgement, not recency.** No time-based ageing. A 24h window was
  considered and rejected: it drops things into Resting whether or not you looked, so "I'll
  review it tomorrow" silently becomes "I never saw it".
- **Resting is deliberately the quietest and narrowest column.** It holds the large majority
  of threads and is *never meant to be read*. If it competes for attention, the board has
  failed its main job.
- **Inferred vs declared asks.** An agent either declares "I need you" via a tool, or a text
  heuristic guesses from its closing sentence. Both land in Needs Help — one place to look —
  but an inferred ask renders visually **subordinate** (dimmer, a `~` marker, a dismiss
  control). This is how the board stays honest about what it actually knows.
- **Manual override offers exactly three targets: Needs Help, Complete, Resting — never
  Working.** The three are *judgements* the human may make. Working is an *observed fact*;
  asserting it doesn't start anything, and offering it would let someone paint a dead thread
  green. Real activity clears an override, so nothing can permanently silence itself.
- **No drag-and-drop, no WIP limits, no swimlanes.** The board is a *projection* of what
  threads are doing, not a field you set. Dragging would turn it back into a lie.
- **Clicking a card opens the thread OVER the board**, never navigating away — clearing three
  cards is three actions, not three round-trips.
- **Mobile is stacked collapsible sections, not swipeable columns.** Swipe was rejected
  because you can't see that two threads need you without swiping to find out, which defeats
  the point. All four counts must be visible with no gesture.
- **The board shows MAIN threads only** — the per-project coordinator and its spawned agents
  are excluded.

---

## Current state

**Screenshots** (attach these — they are the real thing, not mockups):
`board-desktop.png`, `board-mobile-v2.png`, `board-moveto.png`, `board-pty-open.png`

### Card anatomy
Project name (10px, ~50% opacity) → thread label (600 weight) → a detail line → actions.

### Column treatments
- **Needs Help** — amber `#e8b04b` border, tinted background, the question in italics, an
  **Answer** button. Inferred variant: dimmer border, `~` after the label, **Open** + `✕`.
- **Complete** — blue `#5A8DD6`, the outcome line (`✓ shipped v2.7.0, 14 commits`), a `☐`
  check-off. Header carries **Clear all**.
- **Working** — live cards solid with a green dot (`● Running`); then a divider reading
  `WAITING — RESUMES ON ITS OWN`; then pending cards, dashed and dimmed
  (`◌ queued`, `◌ wakes in 20m`, `◌ behind "Sync SKU catalog"`).
- **Resting** — thin border, ~55% opacity, outcome line or `new — no work yet`.

### Header
A `Threads | Board` segmented switch (top bar), then project filter chips with
`All projects` default.

---

## Open — where to spend your effort

**1. Resting at scale.** It currently holds ~120 cards in a single unbounded scroll. It is
explicitly never meant to be read, yet it occupies a full quarter of the screen and scrolls
forever. Should it collapse to a count? Virtualise? Group by project? Show only the most
recent N with a "show all"? This is the biggest unresolved question.

**2. Vertical emptiness.** Needs Help, Complete and Working are usually short (2–6 cards)
while Resting is enormous, leaving three columns ending in a large void. See
`board-desktop.png`. Column layout may be the wrong container for this data shape — but any
alternative must preserve "one glance tells me what needs me".

**3. The Move-to popover.** Currently opens *upward*, overlapping the column header, and its
`⋯` trigger sits bottom-right on the card — a placement chosen to dodge Complete's top-right
checkbox and Needs Help's bottom-left buttons, not because it's right. Trigger placement and
popover anchoring both need a proper answer. See `board-moveto.png`.

**4. Card density and hierarchy.** Cards carry four lines. With Needs Help you want the
question prominent; with Resting you want the whole card to recede. Is one card component
with per-column treatment right, or should the columns diverge more?

**5. Empty states.** What does an empty Needs Help column look like — and can it feel like an
accomplishment (inbox zero) rather than an absence? What does the whole board look like with
nothing running?

**6. The filter chips** wrap to two full rows at 20 projects and eat vertical space above the
fold. See `board-desktop.png`.

**7. Mobile beyond the basics.** The stacked sections work, but: should Complete support
swipe-to-acknowledge? What happens as Resting grows? Is the section header the right place
for counts?

**8. Two small bugs to fold into whatever you propose:**
   - A Complete card prepends `✓`; if the agent's own summary starts with one you get `✓ ✓`.
   - The approved mockup had an **Archive** row below the Move-to divider; it was left out
     of the build and should come back.

---

## Constraints

- **No Tailwind.** Inline `style={{}}` plus CSS custom properties. This is firm.
- **Use the app-global theme tokens**: `--color-canvas`, `--color-base`, `--color-pane`,
  `--color-elevated`, `--color-hover`, `--color-border`, `--color-text-primary`,
  `--color-text-secondary`, `--color-text-tertiary`, `--color-accent` (default `#3ECF6A`,
  **user-customisable**), `--color-status-red`, `--color-status-yellow`.
  Do **not** invent a parallel palette. Note the accent is user-set, so nothing may depend on
  it being green.
- **Dark theme.** Canvas is `#08080A`.
- **Desktop and mobile are both first-class.** Desktop replaces the whole workspace
  (full-bleed, no tree, no tab bar); mobile is a mode selected in Settings. Any proposal must
  answer both.
- **Phosphor Icons** is the icon set already in use.
- Status is **derived**, never authored. The only user-authored state is acknowledgement and
  the three-target override.

## What to deliver

Annotated mockups for desktop and mobile, with the reasoning for each change — especially for
anything that touches the Settled list, since that needs an argument strong enough to
overturn a decision already made deliberately. Prioritise the Resting-at-scale question and
the vertical-emptiness question; they are the two most likely to change the board's shape.
