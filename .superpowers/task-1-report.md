# Task 1 Report — caller identity + one injection path

**Status:** DONE

**Commit:** `90a04b7` — feat(core): agency MCP carries caller identity and rides the standard injection path

## Summary

- `withAgencyMcp` (bespoke `coordinator-<id>.mcp.json` file-rewriting) replaced with
  `agencyServerSpec(terminalId, sessionId): McpServerSpec` (private method,
  `packages/core/src/sessions/service.ts`), pushed into the `specs` array in BOTH
  spawn paths (`spawnTerminal` ~line 1400, `spawnStructured` ~line 1466) BEFORE
  `composeInjection` runs. Gate unchanged: `if (config.role === 'coordinator') specs.push(...)`.
- Env now includes `DISPATCH_TERMINAL: terminalId` alongside the existing
  `DISPATCH_SESSION`/`DISPATCH_PORT`.
- `selfTerminalId()` helper added beside `sessionId()` in
  `packages/core/src/overseer/agency-mcp.ts` (reads `DISPATCH_TERMINAL`); unconsumed
  per plan (later tasks use it).
- Dead `coordinator-<id>.mcp.json` writing deleted entirely; the agency spec now rides
  the same shared `mcp.json` as Doppler/integrations, and since `composeInjection`
  emits both Claude JSON and codex `-c mcp_servers.*` args from one spec list, a codex
  coordinator now gets the server too (previously impossible).

## Structural note (two spawn paths)

Only `spawnStructured` called `withAgencyMcp` today (`spawnTerminal`, the PTY path,
never did — coordinators are always created with `transport: 'structured'`, so in
practice `spawnTerminal`'s own composeInjection call was coordinator-dead code). The
plan explicitly asked for the gate in both, defensively covering the case where
`structuredManagerFor(type)` is falsy and a coordinator-configured thread falls
through to PTY. Implemented identically in both; no awkwardness — both paths build
`specs`/`prompts` the same way just before their own `composeInjection` call.

## Pre-existing tests updated (not new)

`packages/core/tests/routes/structured.test.ts` had 3 tests asserting the OLD
`coordinator-<id>.mcp.json` file directly (a deliberately-removed implementation
detail). Updated to read the shared `mcp.json` instead; added a `DISPATCH_TERMINAL`
assertion to the "folds the dispatch agency server" test. No test deleted, no
assertion weakened — same behaviors verified against the new file location.

## New test (TDD)

`packages/core/tests/sessions/agency-mcp-injection.test.ts` (5 tests): claude-code
coordinator → Claude config has `mcpServers.dispatch` with correct
`DISPATCH_TERMINAL`/`DISPATCH_SESSION`; codex coordinator → spawn args contain
`mcp_servers.dispatch.command="node"` (codex parity); non-coordinator → no dispatch
server (gate holds); PTY-path coordinator → also gets identity; no stray
`coordinator-*.mcp.json` written.

## Verification

- RED confirmed before implementation (4/5 new-file tests failed as expected).
- GREEN: full core suite `cd packages/core && npx vitest run` → **97 files / 783
  tests passed**, 0 failures.
- `cd packages/core && npx tsc -b` → clean, no output.

## Concerns

None. Requirement met: a coordinator's resulting Claude config is equivalent to
before (same server name/command/args/DISPATCH_SESSION), only additions are
`DISPATCH_TERMINAL` and codex now also carrying the server. Ungating deliberately
NOT touched (Task 8).
