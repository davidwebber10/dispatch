# Design Prompt — The Overseer View (Dispatch)

You are designing a new top-level interface for **Dispatch**, a self-hosted control surface for AI coding agents. Today Dispatch organizes work as **threads** (each thread is a `claude`/`codex` agent you drive in a terminal/chat). This new view sits *above* that.

## What you're designing

The **Overseer view** — a **management interface, not a terminal**. The Overseer is a single coordinator the user talks to; it does no implementation work itself. Its job: hold the user's **stream of thought/directives**, show **what's going on** across the work it has delegated, let the user **spin up and steer subtasks**, and surface only the **decisions/approvals/questions** that need a human. Think *mission control / chief-of-staff*, not a code editor or a console.

One Overseer per project. Inside it, work is organized into **missions** (concurrent initiatives, e.g. "auth refactor", "mobile bugs"). Each mission delegates to **ephemeral, typed agent threads** (planner / implementer / researcher / reviewer) that spin up, run, and **dissolve into an outcome when done** (they don't accumulate like today's threads).

## The core idea to honor: a calm two-way membrane

- **Upward:** everything happening across the agents flows up, but **compressed and prioritized** into the few things worth the user's attention. This view must *filter implementation noise*, not relay it. The user should be able to glance and know "what's the state, what needs me."
- **Downward:** the user fires intent/ideas, and the Overseer captures it **durably and instantly** (it's always responsive because it isn't busy doing work).
- The user can **drill into any agent thread** to watch/interrupt/redirect it, then zoom back out — without losing the Overseer's thread.

Design for **fewer, higher-context decisions**, the opposite of a firehose. Calm, legible, glanceable.

## Content this view needs to express (organize as you see fit)

1. **The conversation / directive stream** — the user's running dialogue with the Overseer (fire ideas, get acknowledgements, ask it to do things). This is the durable "intent log." It must feel always-listening and uncluttered by implementation churn.
2. **Ongoing work** — a live, scannable view of current missions and their running agent threads: what each is doing right now, status (working / waiting-on-you / done / error), progress, how long. This is the "current ongoing stuff." Running threads should read as *transient task chips/cards* (with a sense of activity), distinct from anything permanent.
3. **Run / spawn subtasks** — an obvious way to launch new work from here: describe a task → the Overseer proposes (or the user picks) a typed agent (plan / implement / research / review) → it spins up as a tracked thread. Not "open a terminal" — "delegate a task."
4. **Decisions & approvals** — a focused queue of the things only the user can resolve: an agent needs a permission/approval, a clarifying question to answer, or a conflict the Overseer is raising (e.g. *"I saw you tell agent 4 to do X — that contradicts the plan; let's reconcile"*). Each should carry enough context to decide at a glance.
5. **Outcomes / reports** — when an ephemeral thread finishes, its result (a summary, a diff/PR link, key decisions) folds into a durable record here, then the thread itself goes away.

## Interaction principles

- **Glance → act.** The default state answers "what needs me?" in seconds. Detail is one tap away, never in your face.
- **Drill-down without losing context.** Tapping a running thread opens its live detail (watch / interrupt / redirect); closing it returns you to the overview, which kept tracking.
- **Self-pruning.** Completed work collapses to compact outcome cards; the workspace doesn't accumulate clutter.
- **The user is a peer, not an outsider.** When the user steps into a thread, the Overseer reflects that ("you stepped into agent 4"). It's co-driven.
- **Responsiveness is sacred.** Capturing the user's input is instant and never blocked by ongoing work.

## Constraints / fit

- **Web app**, React. Match Dispatch's existing aesthetic: dark theme using its CSS custom-property tokens (`--color-base/pane/elevated/border/text-*/accent`; accent is a green), Phosphor icons, the existing card/panel styling and spacing. It should feel like the same product as the current thread/project UI — a natural new surface, not a bolt-on.
- **Mobile-aware.** It must work one-handed on a phone (Dispatch is used on mobile), so the layout should adapt — likely a focused single-column/stacked mobile form vs. a multi-region desktop layout.
- **No raw terminal here.** Raw agent terminals remain their own (existing) surface; the Overseer is the management layer. (Drill-down may *link* to a thread's detail, but the Overseer view itself is structured panels + conversation, never an xterm.)

## Deliverable

1. A recommended **layout** for desktop and for mobile (wireframe/mockup), showing how the five content areas above are arranged and prioritized — lead with your strongest single concept, and note 1–2 alternatives you considered and why you rejected them.
2. A short **component breakdown** (the key pieces and what each is responsible for).
3. The important **states**: idle/quiet, several missions running, something needs-approval (the escalation state), a thread being drilled into, and the empty/first-run state.
4. Call out the **one or two hardest design problems** (e.g. how to compress "ongoing work" without hiding what matters; how the approvals queue stays glanceable) and how your design handles them.

Optimize for: **calm legibility, fast "what needs me?" triage, and making the user feel like a manager of agents — not an operator of terminals.**
