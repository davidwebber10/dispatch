# Harness policy files of the hosted image

Root-owned files the image installs in each harness's SYSTEM location. A harness reads them above every
user, project and command-line setting, so they hold for a thread Dispatch starts and for a harness an
agent starts by itself from a shell. Every key below was checked against the pinned CLI in the image
(the proof commands are in `docs/hosted.md`, "Harness policy").

| File | Installed as | Image |
| --- | --- | --- |
| `claude-managed-settings.json` | `/etc/claude-code/managed-settings.json` | the standard image |
| `claude-managed-settings.gateway.json` | the same path, when `DISPATCH_ALLOW_MODEL_GATEWAY=1` and the container starts as root | the standard image |
| `claude-managed-settings.developer.json` | the same path | the developer image (`--target runtime-dev`) |
| `codex-requirements.toml` | `/etc/codex/requirements.toml` | the standard image |
| `codex-requirements.developer.toml` | `/etc/codex/requirements.toml` | the developer image |

Claude Code (2.1.322):

- `permissions.disableBypassPermissionsMode: "disable"`: `--dangerously-skip-permissions`,
  `--permission-mode bypassPermissions`, `--allow-dangerously-skip-permissions`, a `defaultMode` in a
  settings file or in `--settings`, and `CLAUDE_CODE_MANAGED_SETTINGS_PATH` all leave the session in
  `default` mode (measured on the session's own `init` frame). `--permission-mode auto`, which smart
  approvals use, still works.
- `allowManagedHooksOnly: true`: a hook in a user or project settings file does not run. Dispatch's
  chat threads use no hook; its CLI threads (developer image) do, which is why that image leaves it out.
- `allowManagedPermissionRulesOnly: true`: `--allowedTools` and `permissions.allow` rules outside this
  file are ignored, so a nested `claude` cannot pre-approve its own tools. Dispatch passes no rule today;
  an `ask` rule for a company write tool must be added HERE when one is needed.
- `forceLoginMethod: "claudeai"`: the person's own subscription login only. It also stops a Claude Code
  process that has `ANTHROPIC_AUTH_TOKEN` before any request (measured 2026-11-13), so a company-model
  thread (docs/hosted.md, "Company models") cannot run under this file.

- `disableClaudeAiConnectors: true` (every file): the connectors of the person's claude.ai account never
  load; a `true` from any source wins, so no user, project or `--settings` value turns them back on.
- `spinnerVerbs`: NOT in these source files. The image build (`hosted-claude-policy-cli.js`) adds the
  POLYWOOD set of `packages/web/src/lib/spinnerWords.ts`, mode `replace`, to each Claude Code file.
- `/etc/claude-code/managed-settings.d` is a link to `/run/dispatch/claude-policy` (root, `0755`): the
  daemon writes the business MCP allow-list there (docs/hosted.md, "Company systems only through the
  platform").

Codex (0.167.0): `[features] apps = false` and `plugins = false` (`codex-requirements.developer.toml`,
for the developer image: `apps = false` only), `allowed_approval_policies` and `allowed_sandbox_modes`. With them
`--dangerously-bypass-approvals-and-sandbox` runs as `approval: untrusted`, `sandbox: read-only`, and
`CODEX_HOME` pointing at another config does not change that.

OpenCode (1.19.5): it reads a managed config from `/etc/opencode`, but the folder can be moved with an
environment variable, and its effect on the flag that skips permissions could not be measured without a
model. The image ships no OpenCode policy.
