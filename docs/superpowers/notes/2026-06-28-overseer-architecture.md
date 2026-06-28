# Overseer / Situation-Room Architecture — Vision + Validated Substrate

**Date:** 2026-06-28
**Status:** Vision note (not yet a spec). Substrate feasibility = CONFIRMED (spike green).

## One-line

Evolve Dispatch from "organized terminals" (a human operating N CLI threads) into a **co-drivable situation room**: a durable **Overseer** that holds the human's stream of thought, dispatches **typed, transparent, ephemeral** agent threads (planner / implementer / researcher / reviewer), monitors them, and surfaces only what needs human judgment — all on **subscription billing**, no PTY.

## Why (the ladder of abstraction)

The human's unit of work climbs: code → tasks → orchestration → strategy → **principal** (objective function, taste, trust, accountability). The bottleneck isn't threads, it's **human attention**. Leverage comes from **width not depth** (parallel workers one hop from intent), **durable artifacts not relayed paraphrases** (anti-telephone), and **verification not delegation chains**. The human moves from being *every connection* to being the **author of intent + final judge + exception-handler**.

## The inversion (core object-model change)

- Today: the **thread** is durable (terminals accumulate).
- Proposed: the **Overseer** is the durable spine (your intent log + noise-gated state feed). **Implementer threads become ephemeral errands** — spawned for a task, monitored, then dissolved into an **outcome card** in the Overseer log. Self-pruning workspace.

## The Overseer = a two-way membrane

- **Up:** all threads' events, compressed/prioritized into the few things needing your judgment (noise gate on implementation churn).
- **Down:** your thoughts/decisions captured **once, durably**, as the reference the agents pull from (not relayed).
- You live *on* the membrane (author down, adjudicate up); the agent-to-agent traffic happens *below* it and you choose not to watch it.

## The Overseer is a custom surface + a pure coordinator (load-bearing, not stylistic)

- **Custom interface, not a thread/PTY/View.** The Overseer gets its own bespoke top-level surface (like Projects/Automations) with structured panels: your **directives / intent log**, **ongoing work** (missions + live threads), **decisions/approvals**, **reports** — plus the conversation. Not rendered as another terminal or chat thread.
- **It does no work directly + has no noisy terminal — on purpose.** An overseer that also implements gets distracted, can't immediately acknowledge/route what you tell it, and pollutes your intent stream with build noise. *(Observed live: in the session that produced this note, the assistant was simultaneously taking David's stream of directives AND building features — and couldn't cleanly ACK incoming directives because it was mid-implementation. That failure mode IS the argument.)* The coordinator/worker split is what keeps the Overseer **always responsive** to your stream of thought and the intent channel **clean of implementation noise**.
- **The human↔Overseer channel is never blocked by work.** Delegated work runs async in threads; the Overseer is always free to receive, ACK, and route.
- **Overseer count (decided):** one Overseer *you talk to* per project (single stream of thought); multiple **missions** organized *inside* it (not multiple overseers-you-talk-to, which would re-fragment); "which project" is resolved by the active-project context; the cross-project **boss** is Phase 2.

## Key properties (what makes it NOT a watered-down agent stack)

1. **Typed + transparent delegates.** The Overseer picks the right role and spawns a **real Dispatch thread** (same as `+` / `api.createTerminal`) — inspectable by you, not a hidden sub-agent chain.
2. **Co-drivable / observed peers.** You can step into any thread to interrupt/redirect; the Overseer *sees* your intervention as an event ("David dropped a note in"), **defers** there, folds your note into its model of intent, and **re-calibrates**. Your interventions are the highest-signal events (direct intent) and double as a teaching signal.
3. **Precedence is dialectic, not mute-override.** The Overseer keeps auto-acting even in threads you've entered — it doesn't freeze. But it *listens* to your interventions and adjusts, and it holds a coherent model of the intent/plan. When your local action **conflicts** with that model it neither silently complies nor silently overrides — it **surfaces the conflict to the human↔Overseer channel** for a conversation (e.g. *"I saw you tell Agent 4 to do X — that contradicts how I'd planned this; let's talk through the changes"*). Reconciliation happens in dialogue; defending coherence of intent is the Overseer's job.
4. **Propagation:** a note in thread #3 can imply changes to #5 — the Overseer notices and adjusts/flags (one note, many threads = the multiplier).
5. **Unified intent capture:** your messages — whether typed at the Overseer or inside a delegate — all converge into the one durable intent log.
6. **Graceful descent:** dropping into a leaf keeps the Overseer watching (no blind spot) and keeps your taste calibrated.

## Validated substrate — the `claude` stream-json control protocol (spike, 2026-06-28, GREEN)

Tested live on `claude 2.1.195`, **subscription auth** (`apiKeySource:"none"`, no API key; `total_cost_usd` reported). One `claude` process per session, driven over stdio NDJSON:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --permission-mode default --permission-prompt-tool stdio
```

- **`--permission-prompt-tool stdio`** is a **hidden/undocumented flag** (what the Agent SDK injects for `canUseTool`). Without it, gated tools silently auto-deny with **no event**. Version-pin + smoke-test it.
- Keep **stdin open** (`--input-format stream-json`) to answer; set `--permission-mode default` explicitly (machine default may be `auto`).
- Events: `system`(init/hook/thinking), `assistant`(thinking|text|tool_use), `user`(tool_result), `control_request`, `control_response`, `rate_limit_event`, `result`.
- **Permission:** `control_request{subtype:can_use_tool, tool_name, input, tool_use_id}` → reply `control_response{response:{behavior:"allow", updatedInput:…}}` or `{behavior:"deny", message, interrupt?:true}`.
- **AskUserQuestion:** arrives as a `can_use_tool` control_request **while pending**, carrying `input.questions[]`. Answer = `allow` with an `answers` map **inside `updatedInput`**, keyed `question-text → option-label` (multi-select = comma-joined). (Answers as a sibling of `behavior` does NOT work.)
- Same channel also exposes client→CLI controls: **`set_permission_mode`** (the autonomy dial), **`interrupt`** (redirect/seize), `initialize`, `hook_callback`, `mcp_message`.
- Reference drivers + raw captures were produced under the session scratchpad (`driver.py`, `driver_askq.py`, `05_perm_stdio_allow.jsonl`, `06_perm_deny.jsonl`, `09_askq_answer2.jsonl`).

These map 1:1 onto the design: `can_use_tool` = policy membrane; `set_permission_mode` = autonomy dial; `interrupt` = redirect; AskUserQuestion-as-event = interactive co-driving.

## Scope & hierarchy

- **Overseer = mission-scoped, not one-per-project.** A project can host **multiple concurrent Overseers**, each owning a different initiative/workstream (e.g. "auth refactor", "mobile bugs", "research X"). Each is its own situation room (intent log + its set of ephemeral typed threads). The **Overseer is the unit of intent/work; the project is the unit of code/repo.**
- **Overseer-boss / cross-project (Phase 2):** a layer *above* all Overseers, spanning projects — effectively an **AI organization** (boss → Overseers → typed threads). Explicitly deferred to Phase 2.

## Build path (incremental, low-regret)

**Phase 1 — the substrate + a single mission Overseer:**
1. **Structured thread mode (core):** a new run mode that spawns `claude` (and Codex's `exec --json` analog) with the stream-json flags + the `control_request`/`control_response` loop. Foundational substrate; PTY becomes the "raw mode" escape hatch.
2. **Live View from the stream:** render View from stream-json events (+ JSONL for history). Fixes poll-lag/refresh bugs; rich tool views become trivial/robust.
3. **Interactive answering:** answer permission + AskUserQuestion from View (the revived feature, now clean).
4. **Autonomy dial + dialectic co-driving:** policy on `can_use_tool` (auto-approve a safe class, escalate the rest) + `set_permission_mode`; per-thread, reversible; the Overseer keeps acting where you intervene but surfaces conflicts to the human↔Overseer channel.
5. **Mission Overseer:** consume its threads' streams, spawn typed/ephemeral threads, the situation-room UI; intent log + noise gate; outcome cards on dissolve. Multiple Overseers per project allowed.

**Phase 2 — the Overseer-boss:** a cross-project layer over the per-mission Overseers (the AI org). Same membrane pattern, one level up.

## Open questions (where the design work lives)

- **Noise-filtering quality** (the membrane's upward compression) — the make-or-break product surface.
- **Ephemeral residue:** what gets captured into the Overseer (summary + diff/PR + decisions) before a thread dissolves; "dissolve" = collapse into an outcome card, JSONL stays on disk. Ephemeral-by-default with **pin-to-persist**.
- **Concurrency/precedence** UI (who's "driving" a thread; Overseer narrates deference).
- **Spawn-vs-note triage:** default capture-to-log; spawn on explicit go/approval (don't dilute by spawning every idea).
- **Economics:** subscription is sized for *interactive* use (5-hr / 7-day caps); continuous autonomy will push toward metered compute. Decouple the control-architecture decision from the billing decision.
- **Undocumented-flag risk:** `--permission-prompt-tool stdio` could change between CLI versions; pin + smoke test.

## Bottom line

Feasibility is confirmed. The whole vision rides one keystone — the stream-json control channel — which is **green on subscription, no PTY**. The path is incremental and each step (esp. #2/#3) improves the current product on its own while laying the Overseer rails.
