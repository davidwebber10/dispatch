# Agent providers: Claude Code, Codex & Grok

> The in-app setup wizard **and the New Thread modal** auto-detect whether `claude`, `codex`
> and `grok` are installed and signed in. A harness whose CLI is missing is greyed out, with
> an **Install** button that runs the command below for you. Installing never signs you in —
> the login step is interactive and you run it yourself.
> This page is the detailed reference behind that.

Dispatch drives coding agents by spawning their **command-line tools** inside managed
terminals. It does not bundle or authenticate them — they run as you, the logged-in user.

So for a "Claude Code", "Codex" or "Grok" thread to work, that CLI must be:

1. **installed** and on your `PATH`, and
2. **authenticated** (signed in) as the user who runs the Dispatch daemon.

This is usually already true on a machine you've been using — this doc is here so a fresh
setup (or an agent doing the setup) can verify and reproduce it.

> **Why "as the same user"?** The daemon resolves your **login shell `PATH`** at startup and
> spawns the CLIs as your user, so they pick up the same binaries and the same per-user
> credential stores (`~/.claude`, `~/.codex`, …) you'd get in a normal terminal.

---

## Claude Code

**Install** (pick one):

```bash
# npm (works everywhere Node is installed)
npm install -g @anthropic-ai/claude-code

# or the official installer
curl -fsSL https://claude.ai/install.sh | bash
```

**Authenticate** — run it once interactively and complete the sign-in (Claude subscription or
an Anthropic API key):

```bash
claude            # follow the login prompt the first time
```

**Verify:**

```bash
command -v claude       # should print a path
claude --version
```

Credentials and settings are stored under `~/.claude`. Docs: <https://docs.claude.com/en/docs/claude-code>

---

## Codex

**Install** (pick one):

```bash
# npm
npm install -g @openai/codex

# or Homebrew
brew install codex
```

**Authenticate** — run it once and sign in (ChatGPT account or an OpenAI API key):

```bash
codex             # follow the login prompt the first time
```

**Verify:**

```bash
command -v codex
codex --version
```

Credentials and settings are stored under `~/.codex`. Docs: <https://developers.openai.com/codex/cli>

---

## Troubleshooting

- **"command not found" inside a Dispatch terminal** — the binary isn't on your **login
  shell** `PATH`. Confirm `command -v claude` / `command -v codex` works in a fresh terminal,
  then `dispatch restart` so the daemon re-resolves your `PATH`.
- **Authenticated in your terminal but not in Dispatch** — make sure the daemon runs as the
  **same user** you authenticated as (the launchd agent installed by `dispatch install` runs
  as you). Re-run the login if needed, then `dispatch restart`.
- **Switching accounts / re-auth** — just re-run `claude` or `codex` in a normal terminal and
  sign in again; Dispatch picks up the refreshed credentials on the next spawned thread.

---

## Grok

xAI's **Grok Build** CLI. In beta, and gated to SuperGrok / X Premium+ subscribers.

**Install:**

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

It installs to `~/.grok/bin/grok` (symlinked into `~/.local/bin`) and appends a PATH block to
your shell rc. Dispatch also probes those two paths directly, so a Grok installed from the
New Thread modal is usable **without** restarting the daemon.

**Authenticate** — a browser OAuth flow. Run it in any thread: Dispatch relays the sign-in
URL to a banner so you can complete it on your phone (see
[browser-auth-relay.md](browser-auth-relay.md)).

```bash
grok login       # or set XAI_API_KEY for pay-as-you-go via api.x.ai
```

**Verify:**

```bash
command -v grok
grok --version
grok models      # the models this account can actually reach
```

Credentials live in `~/.grok/auth.json`. Docs: <https://docs.x.ai/build/overview>

### What Dispatch uses

Every flag below was read from `grok --help` on **Grok 1.0.3**, not from documentation —
several third-party guides describe a `--yolo` flag that does not exist.

| Purpose | Command |
| --- | --- |
| New thread | `grok --permission-mode bypassPermissions [--model <id>] [prompt]` |
| Resume | `grok --permission-mode bypassPermissions [--model <id>] --resume <id>` |
| Agent run | `grok --permission-mode bypassPermissions --single <prompt>` |

`--permission-mode bypassPermissions` is Grok's analogue of Claude's
`--dangerously-skip-permissions` and Codex's `--dangerously-bypass-approvals-and-sandbox`: a
Dispatch thread is an autonomous agent, not a session that should stop to ask.

### Current limits

These are deliberate gaps, not oversights:

- **No Pretty mode.** Pretty needs a bidirectional protocol translated into the Claude-shaped
  event stream `ChatView` consumes. `grok agent stdio` does speak one (ACP), so this is
  buildable — it is the same project Codex Pretty was. Until then the modal renders Pretty
  disabled for Grok.
- **No resume list.** Nothing captures Grok's external session id at spawn, so the modal
  offers no "Resume recent" for it. `grok sessions list` could back this, but it prints human
  text with no JSON output flag.
- **No Doppler secrets MCP.** Grok configures MCP through `grok mcp`, not through argv, so
  there is no per-spawn injection point of the shape the other two providers use.
- **No status hooks.** Grok has no `notify`-style completion hook, so thread status falls back
  to `pty-timing`.
- **Not offered for scheduled agent runs.** `--single` works, but its `streaming-json` emits
  ACP updates that `RunStreamParser` cannot read yet.
