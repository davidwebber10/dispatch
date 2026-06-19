# Agent providers: Claude Code & Codex

Dispatch drives coding agents by spawning their **command-line tools** inside managed
terminals. It does not bundle or authenticate them — they run as you, the logged-in user.

So for a "Claude Code" or "Codex" thread to work, that CLI must be:

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
