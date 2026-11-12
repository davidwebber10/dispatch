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
- `forceLoginMethod: "claudeai"`: the person's own subscription login only.

Codex (0.167.0): `allowed_approval_policies` and `allowed_sandbox_modes`. With them
`--dangerously-bypass-approvals-and-sandbox` runs as `approval: untrusted`, `sandbox: read-only`, and
`CODEX_HOME` pointing at another config does not change that.

OpenCode (1.19.5): it reads a managed config from `/etc/opencode`, but the folder can be moved with an
environment variable, and its effect on the flag that skips permissions could not be measured without a
model. The image ships no OpenCode policy.
