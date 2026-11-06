# Multiple accounts per harness

Date: 2026-11-06. Status: approved in chat; the calls marked "my call" are the builder's.

## Intent

The owner has more than one Claude account and more than one Codex account. Today the daemon
holds one Claude login (its saved token, or the CLI's own keychain login) and one Codex login
(`~/.codex/auth.json`). Every thread uses that one login, and the usage sheet shows one card
per tool.

The owner wants: when a thread is created, pick which signed-in account it runs on, or add a
new one; Settings lists the signed-in accounts under each harness; usage shows every account.

## Goals

- A thread's account is chosen at creation and stays with the thread for its whole life,
  across resume, relaunch and daemon restart.
- Settings → Accounts: per harness, the accounts, which one is the default, add, remove.
- Usage: one ring and one card per account, each with the account's name and plan.
- Adding a Claude account uses the existing headless login (`claude setup-token`). Adding a
  Codex account uses the existing "Sign in" thread (`codex login`) under its own `CODEX_HOME`.

## Non-goals

- Refreshing a stored Claude token. Dispatch never spends the CLI's refresh token. An expired
  stored login shows as such in Settings and asks for a new sign-in.
- Per-account pauses and the warning push in this slice: the "Claude agents paused" group
  stays per tool (my call; a later slice).
- Grok and OpenCode accounts.

## Model

- **Account ids.** `cli` is always present for Claude and for Codex: the CLI's own login on
  this machine (the keychain, `~/.codex`). Added accounts get a uuid.
- **Store.** `~/.dispatch/accounts.json`, mode 0600:
  `{ claude: [{ id, label, email?, accountUuid?, plan?, token, addedAt }],
     codex:  [{ id, label, email?, dir, addedAt }],
     defaults: { claude: id, codex: id } }`.
  A Claude account's token lives here, as the single saved login did in `claude-oauth-token`.
  A Codex account is a folder `~/.dispatch/codex-accounts/<id>` that holds that login's
  `auth.json` and sessions.
- **Migration.** On boot, a saved `claude-oauth-token` with no matching account becomes the
  account `saved` ("Dispatch login"), and the Claude default. Otherwise the default is `cli`.
- **The thread field.** `config.accountId`. The New Thread modal writes it for Claude and Codex
  threads (the chosen account, or the default at that moment). A thread without it uses the
  default at spawn time (old threads).
- **At spawn.** The per-thread env gets the account's overlay, on both the PTY and the
  structured path, so resume and relaunch follow the same field:
  - Claude, an added account: `CLAUDE_CODE_OAUTH_TOKEN=<token>`; `cli`: the variable set
    empty, which makes the CLI use its own login even when the daemon's default env holds a
    saved token.
  - Codex, an added account: `CODEX_HOME=<dir>`; `cli`: nothing.
  - A "Sign in — Codex" thread carries the new account's id, so `codex login` writes into
    that account's folder.
- **Usage.** Snapshots are keyed by tool and account id. The gauge lists every account of
  every tool; each gets its own read: Claude by that account's token (`cli` by the keychain
  or credentials file), Codex by its folder (session files, and `codex app-server` under
  that `CODEX_HOME`). The summary carries `accountId` and `label`; the web shows one ring and
  one card per account.

## Routes (owner only)

- `GET /api/accounts` → `{ claude: [...without tokens], codex: [...], defaults }`.
- `POST /api/accounts/claude/login { label }` starts the headless login for a new account;
  `POST /api/claude-auth/login/code` finishes it as today. The profile call fills email,
  account uuid and plan.
- `POST /api/accounts/codex { label }` makes the folder and returns `{ id }`; the web opens a
  sign-in thread with `config.signIn = 'codex'` and `config.accountId = id`.
- `PUT /api/accounts/:provider/default { id }`, `DELETE /api/accounts/:provider/:id`.

## Build order

1. Daemon: the store, the migration, the spawn overlay, the routes, tests.
2. Daemon: usage per account (snapshots, gauge, readers), tests.
3. Web: Settings → Accounts, the New Thread account row, usage rings and cards per account.
4. Release note; daemon rebuild and restart.
