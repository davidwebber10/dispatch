# Coach — design

Date: 2026-11-07. Owner: David Webber. Status: draft for review.
Replaces the bundled "Prompt coach" plugin (`packages/plugins/prompt-coach`).
Research behind it: three research passes on 2026-11-07 (AI upskilling frameworks, in-product coaching design,
and what Dispatch can see); the sources are listed at the end. Mockups: `.dispatch/inbox/coach-mockups.html`
(parts 1–7), sent to the owner as Previews.

## 1. Intent

People get stuck in one way of using AI and stop improving. Today it is writing prompts; tomorrow it is writing
automations, then running autonomous agents. The owner's thesis: **"you're never thinking big enough when you
use AI"**, and **improving must become the baseline**, not a ladder you climb once.

The Coach meets each person where they are, from the usage they actually have, and moves them up one small step
at a time, forever. It gives prompt advice too, but prompt advice is one part of it, not the product.

It must be **useful and not wordy**: one suggestion, one line of why, one action; more detail only when asked.

Users are **developers and business users** (operations, sales, finance, managers) — business users mostly in
Pretty (chat) mode. The same Coach serves both; only the words and the size of the suggestion change.

## 2. Goals, non-goals, anti-goals

**Goals**
- Each person improves continuously on whichever skill they have stopped growing.
- Advice is specific to what the person just did, never generic "did you know".
- The person controls it: dismiss, mute, how often, what kind, what it remembers.
- It gets better for that person over time through their feedback (a memory, not model training).
- Its cost is visible and bounded, and it runs on the person's own subscription.
- **Tunability is a first-class goal** (owner, 2026-11-07). People differ in how much advice they want, how much
  usage they will spend on it, and which models they trust. Every behavior has a setting with a sensible
  default: how often, which tip types and detectors, thoroughness, harness and the model for each tier, budget,
  quiet hours, projects, phone. An **Advanced** section exposes the detector thresholds and the per-tier model
  choice; the main settings stay simple.

**Non-goals**
- Team or manager reporting. **Each person's Coach data stays private to them** (owner decision). It is a plugin
  installed for you.
- Scoring people against each other. No leaderboards.
- Training a model.

**Anti-goals (it fails even if it "works" if any of these happen)**
- Clippy: tips while you work, tips that return after you dismiss them.
- Pushing people to hand off work they do not check (the "self-automator" result: the people at the top of a
  delegation ladder who stopped checking did worst and learned nothing).
- Walls of text, "should" language, grades of the person, jargon for business users.
- Spending the last of someone's usage limit on coaching.

## 3. The model of improvement: five measures, not one ladder

The research supports a multi-axis model over a single ladder (autonomy is chosen per task — Karpathy's
"autonomy slider"; the expertise-reversal effect; the "OK plateau" starts where a ladder ends). The Coach keeps a
profile on five measures and **always works on the weakest one**, one step at a time:

| Measure | What it means | Signals Dispatch has (section 6) |
|---|---|---|
| **Ambition** | How big a task you give AI | prompt shape (one step vs a whole deliverable), thread run time, new kinds of work |
| **Delegation** | How much the AI does between your messages; parallel threads | human turns per finished task, consecutive tool calls, threads running at once, subagents |
| **Reuse** | Turning repeated work into templates, skills, schedules | repeated prompts, skills/automations/scheduled workers created |
| **Judgment** | Planning first, checking, pushing back | asks for a plan, asks for sources/tests, corrections, interrupts, approves without reading |
| **Breadth** | How many kinds of work you use AI for | kinds of work across threads (code, research, writing, analysis, data, planning), connectors used |

**Gate rule:** while Judgment is low, the Coach does not suggest a bigger handoff (Ambition or Delegation). It
works on Judgment first.

A level name (1–6: Asker, Briefer, Delegator, Parallel operator, Systems builder, Agent manager) may appear only
as an optional summary on the Coach screen. The five measures compare a person only with their own past.

## 4. What the person sees

### 4.1 The card (mockup parts 1, 3, 6)
- **Headline** (≤ 8 words, verb first), **why line** (one sentence naming the specific thing the person did),
  **one action** ("Try it": a rewritten prompt, a template, "Run every Monday", "Split into 3 threads").
- **More** expands: what you wrote, a better version, 2–4 bullets (why it helps, what to check), a "Use this" action.
- **✕ at the top right** dismisses the card. A dismiss means only "not now"; it never teaches the Coach the tip
  was bad.
- **👍 / 👎.** 👎 opens reason chips and an optional "why" box (section 4.4).
- **⋯ menu:** Mute for 1 hour · Mute for today · Mute until I turn it on · Fewer tips like this · Turn off this
  type · Why am I seeing this? · What the Coach knows.
- "Try it" never sends anything by itself: it fills the composer, or opens the schedule/thread dialog for review.
- Every "think bigger" card also says how to check the result.

### 4.2 Where cards appear
- **Under the message box, after a turn finishes** (never while typing). Desktop and phone (phone can be off).
- **The Coach tab in the right column** (the new core `inspectorTabs` contribution, built 2026-11-07): one card
  for the open thread, and the five measures. On the phone it opens from the thread's ⋯ menu.
- **The Coach screen** (its plugin view): card history, the five measures, "What the Coach knows", cost, settings.
- **The weekly recap** (mockup part 5): in the app, Monday, only after 5 active days of data. Three observed
  patterns linked to outcomes, one "stretch" for the week with a one-click start, one line on what the Coach
  learned. Optional push for the recap only.

### 4.3 Cadence and control (mockup part 7)
- **How often:** Off · Quiet (recap and the right-column tab only) · Normal (≤ 3 cards a day) · Chatty (≤ 8).
  Plus: most cards per day, most per session (default 1), quiet hours, cards on the phone, tip types (prompt tips,
  "think bigger" tips), projects to leave alone.
- **Mute** from the card's ⋯ menu or ⌘K → "Mute coach". A banner shows "Coach muted until 3:42 PM · Unmute".
  Nothing queues during a mute.
- **Rest:** a tip type dismissed twice without a reason rests 2 weeks; after the third the Coach offers "Turn off
  this type". Muted types come back for one review after ~60–90 days ("You muted X in August. Show these again?").
- **First week:** one welcome card that says what the Coach looks at and remembers; no other cards.
- Tips never arrive as push notifications.

### 4.4 Feedback and memory (mockup part 2)
- 👎 reason chips, each with one exact, visible effect:
  - I already do this → marks the skill known; no more tips on it.
  - Not relevant to my work → suppresses this tip type for this person.
  - Too basic → raises the level for this measure. Too advanced → lowers it.
  - Wrong about what I did → marks the detection bad for that situation.
  - Not now → pause only.
- The optional free text becomes a plain **fact** ("Not a developer — finance project", "Gets the pipeline report
  from Ops"). The Coach shows the fact for confirmation before it saves it.
- After any feedback, one line says what changed, with **Edit** and **Undo**.
- Implicit signals (✕, ignore, accept) only adjust a tip type's weight; they never create a fact.
- **"What the Coach knows"** lists every fact, known skill, level adjustment and muted type, each with its source
  and date, with Edit and Delete; plus **Pause** and **Reset**. The list is complete — nothing hidden.
- The memory holds facts about how the person works, never prompt content, never personal traits. Facts older
  than 6 months are re-confirmed.
- The memory is part of the context of every model call, so advice improves without training.
- One 👎 never mutes a whole category without asking.

### 4.6 Your goals (owner, 2026-11-07)
- The person says how they want to improve: "I want to hand off whole reports", "I want to automate my Monday
  work", "I want to run more things at once". Free text, up to 3 active goals.
- The Coach **suggests goals** from what it sees (the weakest measure, repeated work, the detectors that fire
  most), each as one line with **Add**. The person can edit a suggestion before adding it.
- Goals steer the Coach: each goal maps to one or more measures and detectors (the small model maps free text);
  cards that serve an active goal rank first and may use the daily cap before other cards; the gate rule (§3)
  still applies.
- The weekly recap reports progress on each goal (what moved, one next step) and asks once a month whether each
  goal is still right: Keep · Done · Change.
- Goals live in the Coach screen and the right-column tab (a short "Working on" line), and are part of "What the
  Coach knows" (edit, delete).

### 4.7 Suggest a plugin (owner, 2026-11-07)
- Reuse has a top step beyond templates and schedules: **a plugin**. When a repeated workflow would be better as
  part of Dispatch itself — a recurring report you open as a screen, a button you would press in every thread, a
  check that should run on every turn, a worker that watches something — the Coach suggests building a plugin.
- Detector `plugin-fit` (v1 signals): the same multi-step workflow 3+ times in 30 days (same prompts or same tool
  sequence) that a schedule alone does not cover; a request the person makes in many projects; a repeated
  "show me X" that would be a view. The small model confirms the fit and names the plugin parts (a view, a
  button, a worker, a hook).
- The card says what the plugin would do in one line and why it beats a schedule or a template. **Try it** opens
  a new thread (pre-filled with `d.actions.openNewThreads`, confirmed by the person) whose first prompt asks an
  agent to build that plugin with `dispatch plugin` / `docs/plugins.md`, starting disabled for review. Nothing
  is created without the person's confirmation.
- The same applies when the Coach sees a better way to do something that only a plugin can give.

### 4.8 Suggest a skill, created in one click (owner, 2026-11-07)
- The Coach proactively suggests **skills**: when the person repeats the same instructions, conventions or
  checklist across threads ("always run the tests and list the files you changed", "use our brand voice",
  "follow the month-end steps"), the Coach drafts a skill that carries them, so every thread gets them.
- Detector `skill-fit` (measure `reuse`): the same instruction block (normalized, ≥ 3 sentences or ≥ 200 chars)
  in prompts of 3+ threads in 30 days, or the same correction given 3+ times. The large model drafts the skill:
  a name, a one-line description, and the `SKILL.md` body, from the repeated text (never other prompt content).
- The card shows the skill's name and one line. **Create skill** opens a review sheet with the draft (name,
  description, body editable, and which projects get it: all, or this project). One click on **Create** there
  writes it and enables it. Nothing is written before that click.
- Core: `POST /api/skills { id, name, description, body, projects?: string[] }` (owner only; the id must be new,
  lower-case slug; the body ≤ 64 KB) writes `~/.dispatch/skills/<id>/SKILL.md` + `skill.json` and enables it;
  SDK `d.actions.createSkill(draft)` opens the review sheet and resolves with the created skill or null.

### 4.5 Cost (mockup part 5, right)
- The Coach screen shows, for this week: calls by model, tokens in/out, an **estimated share of each usage limit**
  (5-hour and weekly) on the account it used, and the budget with a meter.
- **Budget:** "at most N% of my weekly limit" (default 3%). The daemon enforces it as a hard stop (section 7).
- The Plugins page row shows the same totals for any plugin that makes model calls (core change, section 7).

## 5. How it thinks: the cost-versus-intelligence plan

**The lowest cost is not the priority** (owner, 2026-11-07): good advice is. The balance is a setting the person
tunes — **Settings → Coach → Thoroughness**:
- **Economy:** rules propose; the small model confirms; the large model runs only on More / Try it and weekly.
- **Balanced** (default): as Economy, plus the large model writes every card that passes the small model's check,
  and reviews each finished thread once (not each prompt).
- **Thorough:** the large model judges every candidate and every prompt the person sends, with the thread's
  recent turns as context; the small model is used only for cheap labels.
- **Use my budget:** the person gives coaching a share of their usage ("up to 10% of my weekly limit"), and the
  Coach picks the most thorough level that fits that share for the rest of the window, stepping up or down as
  the window goes. For someone who values the coaching, this spends the share on better advice instead of saving it.
The budget (section 4.5) still caps every level; near the cap the Coach steps down a level by itself and says so.
People differ: one wants the lowest cost, another wants to devote a real share of their usage to getting better.
Both are first-class.

The tiers, cheapest first (Economy uses the fewest of the expensive ones):
1. **Rules (no model).** Deterministic detectors over the signals in section 6 propose candidate cards: the same
   prompt three times; three independent threads run one after another; a long idle wait with nothing else
   running; a hand-typed weekly report; a big task started without a plan; output approved within seconds. A rule
   only proposes; it never shows a card alone.
2. **Small model (e.g. Haiku, Terra), once per candidate.** One short call: "Does this card fit, how sure are
   you, and fill the why line." Only high-confidence candidates reach the person. The long, fixed instructions
   come first so the provider's prompt cache can reuse them.
3. **Large model (e.g. Opus, Sol), on demand.** Only when the person clicks More or Try it: the rewrite and the
   detail. No click, no large call.
4. **Large model, weekly.** The recap and the update of the five measures.

Expected shape for a heavy week on Economy (an estimate, to be checked against the cost page): hundreds of rule
checks, ~20–40 small calls, ~5–15 large calls, one recap. Thorough can make one large call per prompt.

**Settings → Coach → Model:**
- **Automatic** (default): use the subscription with the most room before its reset (Claude or Codex). Near the
  limit, drop to the small model only; nearer, rules only. Never use the last of a limit.
- **Or pick a harness** — Claude, Codex, or OpenRouter (any OpenRouter model) — and a **small** and a **large**
  model for it (e.g. Haiku + Opus, Terra + Sol).
- The budget (section 4.5) applies to every choice.

## 6. What it watches

Dispatch already records most signals (research, 2026-11-07): prompts and who sent them (`thread:prompt`,
`message_source`); tool calls including `spawn_agent`, `queue_agent`, `Skill`, `ScheduleWakeup`, MCP tools
(`thread:tool`); turns with time, tokens, outcome including `interrupted` (`thread:turn`, `usage_turns`); thread
statuses and lineage (`terminals.config.spawnedBy`, queued, scheduled); model per thread; automations
(`agent_schedules`, `agent_runs`); skills; subscription usage and resets (`limits/*`, `usage-limits` event).

Not recorded anywhere today: **corrections** (the person telling the agent it was wrong). The builder decides how
to detect them (a small-model label on the person's next prompt is one option) or leaves them out of v1.

## 7. Core changes it needs (useful to every plugin)

1. **Model calls choose harness and model.** `POST /api/plugins/:id/assist` and `d.assist` accept
   `{ harness?: 'claude' | 'codex' | 'openrouter' | 'auto', model?: string }`. Today the runner always uses Haiku on
   the Claude CLI with OpenRouter as a fallback (`packages/core/src/assist/run.ts`). Codex needs a path (the thread
   namer already runs `codex exec`, `sessions/cli-namer.ts`).
2. **Metering records more.** `plugin_assist` gains model, harness, account id, cache tokens kept apart, cost (the
   CLI's `total_cost_usd`, or priced with `analytics/pricing.ts`), and a time-filtered read route
   (`GET /api/plugins/:id/assist/usage?from&to`). The Plugins page shows the totals (today nothing renders them).
3. **Share of a limit.** A server function estimates a plugin's share of each window on an account:
   plugin tokens ÷ all Dispatch tokens on that account in the window × the window's used percent, weighted by
   model price. Shown as an estimate; usage outside Dispatch makes it read high.
4. **Budget enforcement** at the assist route: a per-plugin cap in % of a window or in tokens; refuse with a clear
   error when reached.
5. **Permissions for workers:** `read:usage` (limits and resets) and `read:analytics` (the analytics routes), so the
   Coach's worker can read them with its plugin key. Today these are owner-only.
6. Already built on 2026-11-07: **right-column tabs** (`inspectorTabs`), **export/import of plugin data**, and
   **keep data on remove**.

## 8. Where it runs

- A **worker** (plugin workers exist since slice 5) runs the rules and the weekly job, so coaching does not depend
  on a browser tab being open (today's coach judges only while a tab is open). It writes candidate and accepted
  cards to the plugin's own storage.
- The **web part** renders cards, the tab, the screen, settings, and calls the large model on click.
- All Coach data lives in the plugin's own storage on the daemon (export/import already work).

## 9. Name, packaging, migration

- Name: **Coach** (my call; "Prompt Coach" is too narrow, "Leverage" sounds like a developer tool). Plugin id
  `coach`.
- Bundled with Dispatch, **off by default** (as the Prompt coach is today). Turned on in Settings → Plugins; the
  welcome card explains it.
- It replaces `prompt-coach`. Old observations are not worth migrating (the builder may drop them).

## 9a. Decisions after the builder review (my calls, for the owner to check)

1. **One Dispatch daemon is one person.** "Private to each person" means private to the daemon's owner: plugin
   storage, keys and metering are per daemon today, and each business user runs their own Dispatch. No per-user
   identity is built. (If one daemon must serve several people, that is a separate, larger project.)
2. **One budget number.** "Coaching budget: up to N% of the weekly limit" (default 3%), on the account the Coach
   uses. Economy, Balanced and Thorough treat it as a cap; **Use my budget** treats it as a target and picks the most
   thorough level that fits. The Coach also never takes the last 10% of a 5-hour window. On OpenRouter (no limit)
   the budget is dollars per week.
3. **The hard stop uses the estimate.** The estimate reads high when there is usage outside Dispatch, so it stops
   early, never late — the safe direction. The Coach screen labels it an estimate. Exact token counts show beside it.
4. **Each tier may use a different harness** (Advanced): for example the small model on Codex, the large on Claude.
   `assist` takes harness and model per call, and metering records the account per call. **Automatic** compares
   the accounts in `accounts.json` (multi-account), not only Claude against Codex.
5. **Core surfaces.** ⌘K commands already exist for plugins (`commands`, docs/plugins.md), so "Mute coach" needs no
   core work. The card sits in the existing `composer.before` slot (between the chat and the message box, as in the
   mockups). Two new core actions are in scope: (a) **open the schedule dialog or the new-thread dialog with
   fields filled**, for "Run every Monday" and "Split into 3 threads" (the person reviews and confirms); (b) **a
   plugin push notification** behind a new `notify:push` permission, used only by the weekly recap and only when the
   person turns it on.
6. **Prompt coach is removed in the same release.** If it was on, Coach starts on (the choice carries over);
   otherwise Coach starts off. Old observations are dropped. The two never run at the same time.
7. **"Never prompt content" applies to the memory's facts.** The card history may keep a short excerpt of what you
   wrote (for "More"); Reset and Delete my coach data remove it, and it is in the export.

## 10. Left to the builder

- The default rule thresholds (counts, minutes, days); the research numbers are starting points, not findings.
  Each threshold is a setting under Advanced (section 2), so the defaults only need to be sensible.
- The detector list for v1 beyond those named in section 5.
- How the five measures are computed from the signals, and their windows.
- The storage layout inside the plugin's documents.
- The card visuals within the mockups' layout.
- Whether corrections ship in v1 (section 6).

## Sources (from the 2026-11-07 research)

Anthropic AI Fluency Index and 4D framework; BCG/Harvard "jagged frontier" study and its cyborg/centaur/
self-automator follow-up; Karpathy "Software 3.0"; Willison on agentic engineering; Microsoft Work Trend Index
2024–2025; McKinsey State of AI 2025; METR 2025; Kluger & DeNisi 1996; Hattie & Timperley 2007; Horvitz CHI '99;
Iqbal & Bailey CHI 2008; Yancey & Settles KDD 2020 (Duolingo); Mollick & Rothbard (consented gamification);
Google PAIR Guidebook (feedback and control); Mozilla's YouTube user-controls study; Grammarly, Superhuman, Whoop,
Oura product patterns. Full links are in the research reports in this session's transcript.
