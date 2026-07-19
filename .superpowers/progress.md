# Peer-threads SDD progress (plan: docs/superpowers/plans/2026-07-19-peer-threads.md)
Task 1: done (90a04b7) — identity + injection path; review in flight
Task 2: done (26c2ea1) — thread_watches table + accessors, 801 core tests
- CARRY-FORWARD (fold into Task 5 wiring): no FK from thread_watches -> terminals (deliberate; foreign_keys=ON would block terminal deletion). Therefore terminal deletion MUST call watchesDb.removeForTerminal(id), else orphan watch rows accumulate. Dispatcher already drops watches whose watcher row is gone (read-side safety), so this is hygiene not correctness.
Task 3: done (b77b7ab) — watch endpoints, project-scoped, 811 tests
Controller fix (4e62b6e): watches defaulted to REPEATING against spec (one-shot); impl+tests both encoded the wrong default. Fixed to one-shot; repeating needs once:false.
Task 1 REVIEW: Needs fixes — CRITICAL race: per-terminal identity (DISPATCH_TERMINAL/SESSION) written to daemon-wide mcp.json; Claude reads the path at child startup, kickstartInterruptedAgents revives many threads in a sync loop -> a thread can read another project's config. Fix dispatched: per-thread config path (thread-<id>.mcp.json) + regression test sharing ONE service across two sessions.
- Deferred from that review (Important, no regression vs pre-diff): composeInjection write failure now fails the spawn instead of degrading to un-augmented config. Revisit if spawn-time IO errors ever surface.
