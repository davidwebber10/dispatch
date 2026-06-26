# executor CLI/MCP surface (probed for the integration layer)

executor **v1.5.20**, MIT, `npm i -g executor`. Bin: `executor`.

## MCP (the key piece)
- `executor mcp` — **starts an MCP server over stdio**. No daemon required: each
  agent launch runs its own `executor mcp` subprocess against the shared on-disk catalog.
- Flags:
  - `--scope <dir>` — workspace dir containing `executor.jsonc` (per-project catalog). Omit for the global/default catalog (the "one shared layer").
  - `--elicitation-mode browser|model` — approval flow. `browser` pops a browser approval per tool; `model` exposes a CLI resume tool to the model (the agent drives approval). For Dispatch (terminals run `claude --dangerously-skip-permissions`), `model` avoids blocking browser popups mid-run.

### Decision — injection spec (use in Task 4)
```
{ name: 'executor', command: 'executor', args: ['mcp', '--elicitation-mode', 'model'] }
```
Global catalog (no `--scope`) for the shared layer. (Per-project scoping via `--scope <workDir>` is a later option.)

## Other subcommands (later phases)
- `executor tools` — discover tools + sources (for the list UI, phase 2).
- `executor call <path> '<json>'` — invoke a tool (e.g. `executor call github issues create '{...}'`).
- `executor install` / `service` / `daemon` — OS-supervised background service + local daemon (for the **web UI** / always-on). Optional; NOT needed for stdio MCP injection. Deferred.
- `executor web` / `open` — open the web UI to manage the catalog.
- `executor login` / `whoami` / `server` — sign in to a **hosted** executor server (device flow). Not needed for free self-host.
- Catalog/config file: **`executor.jsonc`** (workspace) — the export/import artifact for phase 4.
- Adding sources: management tools are exposed through `executor mcp` itself, so agent-assisted add (phase 5) works by the model calling executor's own tools. Exact `addSource` CLI form to confirm in phase 2 via `executor tools --help` / `executor call executor --help`.

## Implication for the MVP
No daemon supervision needed — `IntegrationsService.getServerSpec()` just returns the stdio spec above when `executor` is on PATH; injection composes it into both providers. `IntegrationsService.status()` = `executor --version` probe.
