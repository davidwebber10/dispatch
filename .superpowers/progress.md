# Peer-threads SDD progress (plan: docs/superpowers/plans/2026-07-19-peer-threads.md)
Task 1: done (90a04b7) — identity + injection path; review in flight
Task 2: done (26c2ea1) — thread_watches table + accessors, 801 core tests
- CARRY-FORWARD (fold into Task 5 wiring): no FK from thread_watches -> terminals (deliberate; foreign_keys=ON would block terminal deletion). Therefore terminal deletion MUST call watchesDb.removeForTerminal(id), else orphan watch rows accumulate. Dispatcher already drops watches whose watcher row is gone (read-side safety), so this is hygiene not correctness.
