# Harness telemetry architecture

Implemented locally, September 18, 2026. These changes are unreleased. No daemon restart, live database migration, version bump, tag, or publication was performed.

## Provider boundary

Every provider declares its structured protocol, feature gate, hook aliases/parser, PTY capture capability, and telemetry overrides. Shared defaults normalize usage and explicitly represent unsupported collection. Claude Code, Codex, Grok, and OpenCode use the same recorder and lifecycle wiring. Protocol-specific managers remain responsible for native I/O, permissions, and translation.

The registry is exhaustive over `AgentType` and rejects unknown names. SessionService registers managers through one map and binds shared native-session persistence once. All structured harnesses load through the registry's protocol declarations. The UI shares the pure catalog and consumes the running server's enabled capabilities.

## Storage and reads

- `usage_turns`: one lifecycle record per Dispatch turn, with outcome, transport, external session/native turn identity, explicit coverage, and nullable duration. Token totals are a transactionally maintained projection of facts.
- `usage_facts`: normalized usage, tool, and cost observations with model, source, parser version, timestamp, and provider event identity. Identity is unique within the terminal/provider/native-session scope. Native snapshots update monotonically; replay from an earlier turn cannot migrate into the current turn.
- `usage_checkpoints`: cumulative counters and revisions. Advancing a checkpoint and recording its delta happen in one transaction. A decreasing counter establishes a new baseline and marks coverage partial instead of billing negative usage or old history.
- `thread_lifecycle`: last authoritative or inferred status and observation time. PTY redraw timing cannot overwrite authoritative lifecycle state.
- `usage_measurements`: new facts plus a compatibility view over historical turn aggregates. Dashboard, thread statistics, and fleet summaries all read this ledger. `usage_daily` is retained for compatibility on disk but no longer receives a second stream of accounting writes.

Migration is additive, versioned, transactional, and idempotent. Historical aggregates stay intact and are labeled partial/missing; historical zero cost becomes unknown. There is no guessed historical backfill. New interrupted turns have unknown duration, avoiding fabricated multi-hour timing after restart.

## Harness accounting

### Claude Code

Streaming `modelUsage` totals cover the current CLI invocation, including subagents. Final totals become per-model facts using durable cumulative deltas, scoped to a new generation for each CLI invocation. Repeated results do not add usage. Scheduled runners follow the same path. `total_cost_usd` is tracked separately using the same scope.

Assistant frames still provide tool identities, but their placeholder output counts are not used for live structured accounting. If a CLI omits `modelUsage`, its turn `usage` is retained as partial because model attribution and subagent coverage are unavailable. If a process crashes before reporting final usage, that turn remains missing rather than reporting a measured zero.

Claude PTY capture reads new transcript responses from the turn-start byte cursor, deduplicates native response IDs, and preserves each response's model. Incomplete, malformed, missing, or truncated transcript data yields partial coverage.

Source: [Anthropic cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking). It documents placeholder assistant output counts, invocation-scoped streaming totals, and subagent inclusion. Harness-reported dollar amounts are estimates from the harness, not invoice records.

### Codex

Context-fill gauges are distinct from accounted usage. App-server cumulative totals feed persisted checkpoints; displayed usage deltas never enter accounting a second time. An idle/resume snapshot establishes a baseline without importing history. Without a baseline, only an explicitly observed last call is attributable and coverage is partial. Native turn IDs reject stale usage from another active turn.

PTY capture compares transcript totals at explicit start/end boundaries. Its aggregate model attribution is partial. Fresh sessions can be captured on their first turn even when the transcript appears after start. Resumed sessions without a baseline do not import old totals. Headless `codex exec` turn summaries also feed the shared ledger, with partial model attribution.

Source: [OpenAI protocol implementation](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs), `TokenUsageInfo::append_last_usage`.

### Grok and OpenCode

ACP normalization uses an explicit dialect for whether cached input is included in the input total; token magnitudes never decide the accounting rule. Response/turn usage enters the same ledger. OpenCode's explicitly reported USD cost uses a durable cumulative checkpoint. Unverified Grok cost-tick units remain excluded. PTY usage capture for these harnesses is explicitly unsupported.

## Turn and status reliability

Explicit baseline/start/end events drive PTY accounting independently of display-status transitions. Permission pauses do not close turns. Duplicate busy/start/end signals are idempotent. Runner terminals have a single owner for accounting, so a PTY process-exit callback cannot close their turn before final output is parsed.

Final frames are delivered before settlement. All structured managers propagate failure and exit; old-process callbacks cannot settle replacement sessions. SessionStart means waiting for a prompt, not active work. Startup reconciliation clears persisted active state that has no live process owner. Output timing remains an inferred fallback only for threads without authoritative lifecycle observations.

A missed completion event from a still-running CLI cannot be proven complete from output silence alone. PTY hooks without native sequence/generation information also cannot provide complete ordering guarantees. Those limitations remain; these changes do not claim every upstream event is observable.

## Coverage and cost

Coverage is explicit: `reported`, `partial`, `missing`, or `unsupported`. A reported zero differs from missing usage/cost. API list-price estimates and harness-reported dollars are separate fields and dashboard values. The existing Claude-focused rate table is identified by version; rates were not refreshed. Unknown models, mixed-model PTY aggregates, missing native identities, and incomplete observations are represented without inventing precise costs.

## UI and validation

Board navigation and the mobile Threads/Board picker are hidden. Saved Board selections resolve to Threads; existing Board code/preferences are preserved for future work.

Regression coverage includes native response deduplication, cumulative counters across turns/process restarts, transactional rollback, mixed-model dashboard/fleet parity, reported zero versus unknown cost, historical migration, first-turn PTY capture, permission pauses, transcript truncation, stale output redraws, dead-process reconciliation, runner ownership, final Claude fixture totals, and native failure/exit ordering. No live billable agent session is required by these tests.

## Follow-up architecture work

The five follow-ups are now implemented in this working tree:

1. **Lifecycle ownership:** `StatusService.accept` is the shared owner of structured/runner lifecycle transitions. Usage, status, native identity/sequence guards, and diagnostics commit in one SQLite transaction. Notifications and watcher callbacks run afterward. Reentrant events triggered by completion effects queue behind the current transition, preventing a previous idle broadcast from overwriting a newly started turn. PTY hook transitions also use a transaction; timing inference and SessionService status writes route through the owner in server wiring.
2. **Typed internal events:** `runtime/events.ts` defines Dispatch events for process/session, turns, permissions, usage, and capture failure. `runtime/adapter.ts` translates existing manager emissions at the boundary. Native Claude-shaped chat frames remain a UI/protocol compatibility stream; lifecycle and accounting consume the typed contract. Each event includes process generation, sequence, local turn identity, and available native identities. Retired generations and stale/duplicate completions are rejected.
3. **Registry and capabilities:** all four managers, including Claude, use one factory/wiring loop. The pure harness/model catalog is shared across packages. `/api/setup/harnesses` reports enabled transports, resume/branch/permission support, and telemetry capabilities. The modal consumes these capabilities, and creation rejects disabled transports server-side. Existing presentation and preference behavior is preserved.
4. **Atomic ingestion and migrations:** all measurements/checkpoints from a multi-model event commit together. A failed status write also rolls back closure/accounting and discards pending notifications. Capture failures are recorded explicitly and open usage is marked partial. Schema upgrades use ordered, transactional entries in `schema_migrations`; failures abort startup instead of being swallowed. Future upgrades must append a new migration ID rather than edit an already-applied migration.
5. **Diagnostics and contract tests:** `/api/terminals/:id/diagnostics` exposes current lifecycle, capture failures, and the last 200 transition records for that thread. History records metadata only, not prompts or tool arguments. The shared harness suite exercises duplicate starts/completions, permission pauses, failure/cancellation, reconnect, retired processes, stale turns, rollback, and notification ordering, alongside each protocol's existing translator/manager tests.

## First-prompt naming

The first submitted human prompt is stored once in `thread_naming_prompts` and schedules naming immediately, without waiting for a native session ID or transcript. A pending request survives restart. The title model/key lookup has a three-second budget; failure produces one task-prefix fallback. Late model results and later prompts never replace the title. A manual rename wins through the existing `label_source='default'` conditional write, including while generation is running.

Structured sends, complete terminal input, and prompt-submission hooks feed the same naming service. Terminal history/cursor edits that cannot be reconstructed safely fall back to transcript extraction. The extractor excludes injected AGENTS.md and environment instructions, and prioritizes the first genuine prompt over later summaries. Fallback titles remove common greetings and polite prefixes. Already named threads retain their names; this change does not bulk-rename existing threads.

## OpenCode settings integration

The changes from `feat/opencode-model-settings` (`7db9b3e`) are incorporated into this working tree. The shared core catalog keeps OpenCode's static `models` empty; `OPENCODE_DEFAULT_MODELS` remains the daemon-owned default list, and harness settings supply the effective user list. The shared Codex catalog includes `gpt-6-astra`. Pricing coverage checks read both sources directly.

The New Thread modal combines server capability gating with the effective model list and the searchable picker. Regression coverage verifies custom OpenCode selection with server capabilities, and that scrolling within the picker does not close it. This integration does not change the release version or deploy the running daemon.
