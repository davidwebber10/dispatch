# Coach

A bundled Dispatch plugin. It looks at how you work with AI and suggests one small next step at a
natural break: one headline, one line of why, one action. More detail only when you ask.

It replaces the Prompt coach. It is on by default: a new install first shows only a welcome card that says what the Coach looks
at and remembers, with Turn off; then a quiet first week. An owner who had turned the Prompt coach
off keeps the Coach off.

- **Where it shows:** a card under the message box after a turn ends, a Coach tab in the right
  column (the open thread's tip, your goals and the five measures), the Coach screen (the weekly
  recap, your goals, the measures, the card history, what the Coach knows, and what it costs),
  and Settings → Coach.
- **What it watches:** the thread events Dispatch already records (prompts you send, tool calls,
  turn ends). The worker runs the rules, so coaching does not need an open tab. Prompts from other
  agents, and every project on your leave-alone list, are ignored.
- **How it thinks:** rules propose a tip; a small model checks that it fits and how sure it is;
  on Balanced and up a large model writes it. More, and the Monday recap, use the large model.
  Thoroughness (Economy, Balanced, Thorough, Use my budget) sets the mix; near the budget the
  Coach steps down a level by itself, and the Coach screen says so.
- **Five measures:** ambition, delegation, reuse, judgment and breadth, each from 0 to 100 over
  30 days. They compare you only with your own past. The Coach works on the weakest one, and
  works on judgment before it suggests a bigger handoff.
- **A plugin, when it fits:** when you run the same multi-step workflow 3 times in 30 days and no
  schedule covers it, the Coach may suggest building a plugin for it. Try it opens a new thread,
  for you to confirm, that asks an agent to build the plugin; it starts disabled for your review.
- **Your goals:** up to 3, in your own words or from a suggestion. Tips that serve a goal come
  first. The recap reports each goal and asks once a month whether it is still right.
- **What it costs:** it runs on your own subscription. The budget (default: 3% of the weekly
  limit; $5 a week on OpenRouter) is a hard stop that Dispatch enforces. The share of a limit is
  an estimate, and reads high when you also use the account outside Dispatch.
- **What it keeps:** its documents in the plugin's own storage on your daemon. Memory facts never
  hold prompt content; the card history keeps a short excerpt, removed by Reset.
- **You control it:** how often (Off, Quiet, Normal, Chatty), cards a day and a session, quiet
  hours, the phone, tip types, projects to leave alone, the recap and its push, the model, the
  budget, mute (⌘K → "Mute coach"), and what it remembers. Advanced has every rule threshold.

## Files

| File | What it does |
| --- | --- |
| `web.js` | the card, the tab, the Coach screen, the settings |
| `worker/index.mjs` | the worker's I/O: the plugin key, the daemon's routes, stdin |
| `lib/engine.mjs` | the worker's logic: fold events, detect, judge, measures, the recap |
| `lib/signals.mjs`, `lib/detectors.mjs` | the signals state and the seven rules |
| `lib/plan.mjs`, `lib/prompts.mjs`, `lib/judge.mjs`, `lib/client.mjs` | the tier per step, the prompts, the judge, the assist call |
| `lib/cadence.mjs`, `lib/memory.mjs`, `lib/goals.mjs` | when a card may show, what the Coach knows, your goals |
| `lib/measures.mjs`, `lib/recap.mjs` | the five measures and the weekly recap |
| `lib/settings.mjs` | every setting and its default |

## Documents

`signals` (the rolling state), `candidates` (what the rules proposed), `cards` (the judged cards,
and a record of each judged candidate), `cardState`, `cadence` (caps, mute, rests), `memory`
(facts, known skills, level adjustments, muted types, goals), `status` (the budget the worker
last heard), `measures` (scores, a daily history, suggested goals), `recap`.

Design: `docs/superpowers/specs/2026-11-07-coach-design.md`.
