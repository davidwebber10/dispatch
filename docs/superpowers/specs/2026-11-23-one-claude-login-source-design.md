# One source for the Claude login

Date: 2026-11-23. Status: approved by the owner on 2026-11-23, with the four decisions of
section 9 as recommended; built (section 11). Follows issues 185 and 188 and pull request 186 (released in 4.12.2). Earlier design: `2026-11-06-multi-account-design.md`.

## Intent

The owner picks which Claude login a thread runs on, and which one is the default. Today that
choice holds for threads only. Chat, thread titles, the usage probe and the sign-in checks get
their login from a second place, the old single-login token file, which the daemon puts into the
base environment of every child process. So the app can show one account and use another.

This design leaves one source: the account. Every Claude process gets its login from the same
function, and a sign-in always lands in an account that the owner can see.

## What is wrong today

The audit (issue 188) found 14 paths that give a Claude process its login. Four follow the
chosen account, two were fixed by pull request 186, and eight do not follow it:

| Path | What it does when the old token file exists |
| --- | --- |
| Chat turns, Chat compaction | run on the old token, whatever the default is |
| Thread titles | the same |
| The usage probe for the CLI login | runs with the old token |
| The usage identity of the CLI login | is taken from the old token, so figures land under another account |
| The sign-in check that gates new threads | says "signed in" because of the old token |
| "Is the CLI login signed in" | true whenever the old file exists |
| Sign-in from the generic card | writes the old file, not an account |

What the owner sees: a sign-in from the Chat card repairs Chat and titles and does nothing for
threads; the usage ring of one account shows another account's figures; the signed-out banner
and the account list disagree with what a thread gets.

## Goals

1. Every Claude process that the daemon starts gets its login from `AccountsStore.spawnEnv`.
2. The base environment never carries a Claude token on an install that uses accounts.
3. `cli` always means the login of the machine. Nothing else can stand in for it.
4. A sign-in from any screen lands in a named account, at once, and never becomes the default
   without the owner's yes.
5. Each rule above has a test that fails when a path stops following it.

## Non-goals

- Codex accounts. They were not part of the audit.
- A hosted box on the clean login (`claude auth login`). It reads no token today and does not
  change. A test holds that.
- Stopping the running processes of a removed account (issue 188, gap C).
- An account field on a scheduled job (gap D). It comes after this, as its own change.
- Refreshing or revoking a token.

## The rule

> A Claude process runs on the account of its thread. A process with no thread runs on the
> default Claude account. `spawnEnv('claude-code', config)` is the only code that turns an
> account into environment variables.

`spawnEnv` already answers in full for each kind of account: for the CLI login it blanks
`CLAUDE_CODE_OAUTH_TOKEN`; for a token account it sets the token; for a hosted account it sets
the config folder and blanks the token. Because the overlay always sets the variable, a path that
applies it cannot inherit another login.

## 1. The base environment

`daemon/wire-pty.ts` stops spreading `claudeLogin.getSpawnEnv()` into the base environment.
After this, a path that forgets the overlay gets the login of the machine, not a token it was
never given. On an install whose only login is a token account, such a path fails loudly
(signed out), which a test and a person both notice.

`ClaudeLoginService.getSpawnEnv()` has no caller left on a local install and is removed. The
hosted providers of the base environment (the brokered tools) are not touched.

## 2. Each path

| Path | Account it uses | Change |
| --- | --- | --- |
| Threads, scheduled runs, role runs | the thread's, else the default | none |
| Assist | the request's, else the default | none for the call; its "is the CLI login usable" check asks under the `cli` overlay |
| Chat turns | the default Claude account, read at the start of each turn | the turn's environment gets the overlay |
| Chat compaction | the same as the Chat turn | the same |
| Thread titles | the account of the thread that is named; the default when the thread is gone | `cliTitle` gets the thread id; the title generator applies that thread's overlay |
| Usage probe turn, `get_usage` read | the account that is probed | for `cli` the overlay is `spawnEnv` of `cli` (blank token), not an empty object |
| Usage identity of `cli` | the CLI login's own credential | `limitAccount` no longer reads `claudeLogin.getToken()` |
| The sign-in check that gates a new thread | the account the new thread will use (its pick, else the default) | the check takes an account id and asks under that overlay; for a token account "signed in" is "a token is stored and the CLI is installed" |
| "Is this account signed in" for `cli` | the CLI login only | the `claudeLogin.isAuthenticated()` shortcut goes |

Chat uses the default account and has no setting of its own (owner decision 1). A change of the
default applies to Chat from its next turn.

## 3. Sign-in

Today there are two flows. The account flow (`startForAccount`) stores the token in a named
account. The generic flow (`POST /api/claude-auth/login`, the default of the sign-in card)
writes the old file. After this design there is one result: an account.

- **Sign in again for an account** (already there): the token of that account is replaced.
- **The generic card** (Chat, the signed-out banner, a thread's card with no account): on a
  local install it runs the account flow.
  - When the default account is a token account, its token is replaced. Nothing else changes.
  - When the default account is the CLI login, a `setup-token` sign-in cannot repair it: that
    login belongs to the `claude` command. The card says so, in this order:
    1. "Your computer's Claude login is signed out. Run `claude` in a terminal and sign in
       there to keep your claude.ai connectors (mail, calendar, chat)."
    2. "Or sign in here. This makes a Dispatch login, which has no claude.ai connectors."
    A sign-in here makes a new token account. The card then asks: "Use this login for new
    threads and Chat?" with **Make default** and **Not now**. No default changes without that
    press (owner decision 3).
- The old file is no longer written. `saveToken` and the old route's write path go; the route
  stays as a thin alias so an older open tab still works.
- The one-time move of an old file into the account `saved` at start stays as pull request 186
  left it: it adds the account, and takes the default only on an install with no account store.

## 4. What the owner can tell apart

A token account has no email and no plan: the profile endpoint refuses a `setup-token` token.

- A new token account gets a label with its origin and date: "Dispatch login, 23 Nov". The
  account `saved` keeps "Dispatch login" and gets the date of its token file when it is made.
- The Accounts page says under a token account: "No claude.ai connectors. Threads on this login
  cannot read your mail, calendar or chat connectors." Under the CLI login: "Has the claude.ai
  connectors of this computer's login."
- The line under the default picker says what follows it: "New threads, scheduled jobs, Chat and
  thread titles use the default account."

## 5. What changes for an install

| Install today | After the update |
| --- | --- |
| Default is the CLI login, no old file | nothing changes |
| Default is a token account | Chat, titles and the probes now use that account too (before: the old file's token, or the CLI login) |
| Default is the CLI login, an old file exists, the CLI login works | Chat and titles move from the old token to the CLI login. Chat gains the connectors of that login |
| Default is the CLI login, an old file exists, the CLI login is signed out | Chat stops working until the owner signs in. The card offers both ways (section 3). The release note names this case |
| Hosted, clean login | nothing changes |

The usage figures of the CLI login may jump once: they stop including another account's reads.

## 6. Tests

- **A login table test** (`tests/auth/login-sources.test.ts`): for each path of section 2, the
  environment that the path builds, for a default of `cli`, a token account and a hosted
  account, each with and without an old token file. It asserts the value of
  `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CONFIG_DIR`. A new path that starts `claude` without
  the overlay has no row, and a second test fails on that: it reads the source for every place
  that starts the `claude` command and checks each against a list.
- The base environment holds no `CLAUDE_CODE_OAUTH_TOKEN` (local, with an old file present).
- Sign-in: the generic flow stores an account and writes no file; it replaces the token of a
  token default; with a `cli` default it makes an account and leaves the default; **Make
  default** sets it.
- Hosted clean login: the same table, unchanged from `main`.
- **End to end**, on an isolated daemon with a stand-in `claude` command that records which
  login it was given (never the value: a label per fake token): one thread per account, one
  scheduled run, one Chat turn, one title, one probe.

## 7. Build units

Each unit is test-first and leaves `main` working.

1. The login table test for the paths that are right today (threads, assist, `get_usage`), and
   the source scan. They pass on `main` and protect the rest.
2. The base environment without the token; Chat turns and compaction on the default account.
3. Titles on the thread's account; the usage probe and the usage identity of `cli`.
4. The two sign-in checks.
5. Sign-in lands in an account: the generic flow, the card's two ways, **Make default**.
6. The labels and the lines on the Accounts page. Release note.

Units 2 to 5 ship in one release: unit 2 alone would leave the Chat card writing a file that
nothing reads.

## 8. Roll back

A revert of the release. `accounts.json` gains no new field that older code cannot read, and no
file is deleted by the update. A token account that the new card made stays as an account; older
code lists it and can use it.

## 9. Owner decisions (2026-11-23)

1. **Chat's account** is the default account. Chat has no account setting of its own.
2. **A thread's title** is made on the account of that thread.
3. **The generic card when the default is the CLI login** offers both ways, and asks before the
   default changes.
4. **Units 2 to 5 ship in one release.**

## 10. Left to the builder

- The exact wording of the card and the Accounts page lines.
- Where the stand-in `claude` of the end-to-end check lives, and how it is put on the path of
  the isolated daemon (the daemon takes its path from the login shell).
- Whether `ClaudeLoginService` keeps `isAuthenticated()` for the hosted surface under another
  name.

## 11. Build record (2026-11-23)

Units 1 to 6 are built on one branch. Where this section and a section above differ, this one
is right.

- **The source** is `auth/claude-login-sources.ts`: `overlay(account)`, `processEnv(account)`
  and `accountOf(config)` for the login, and `claudeSignedIn(account)` for the gates. The daemon
  wires the signed-in check once (`setClaudeSignedInSource`).
- **The guard** is `tests/auth/login-sources.test.ts`: the table, and a scan of the source that
  fails when a file starts `claude` and is not on its list.
- **The account kind** in the public list is `cli`, `saved` (a sign-in that Dispatch keeps) or
  `folder` (a login folder of its own). The word for the secret is not used: an older test
  proves that the list never holds it, and that test stays strict.
- **The card says the two ways once the link is on screen,** not before the sign-in starts: the
  daemon decides where a sign-in lands when it starts, and tells the page (`landsIn`).
- **The old file.** The daemon never writes it: a generic sign-in always has a target. The write
  path stays in `ClaudeLoginService` for the case where no account sink is wired, which is only
  a unit test of that class. `isAuthenticated()` stays for the hosted surface.
- **`GET /api/claude-auth`** answers "is the default Claude account signed in" on a local
  install.
- **Not built:** the date in the label of the migrated account `saved` (a new Dispatch login
  has it); the stand-in `claude` of the end-to-end check as a script in the repository.

The end-to-end check, by hand on an isolated daemon, with a stand-in `claude` that records a
label for the login it was given. The install had a saved sign-in "Team", an old token file,
and the CLI login as the default:

| Process | Login it got |
| --- | --- |
| Thread with no account | the CLI login |
| Thread on "Team" | Team |
| Thread on the migrated old file ("Dispatch login") | that login |
| Usage probe, one per account | each its own; the CLI login's probe got the CLI login |
| Chat turn, default = the CLI login | the CLI login |
| Chat turn, after the default changed to "Team" | Team |
| New thread with no account, after that change | Team |

No token text reached the daemon log.

Two tests failed in one full run of the core suite and passed alone: `tests/routes/watches.test.ts`
and `src/routes/git.test.ts`. Both are the known port collision of the route tests, not this
change.

### Review round 1 (an independent Codex review, 2026-11-23)

Four findings, all real, all fixed on the branch:

- **The New Thread window closed its gate for a working saved sign-in.** With the token gone
  from the base environment, the machine check answers for the machine login only, and the
  window used it for every Claude thread. Now the setup routes answer "the default Claude account
  is signed in", and the window applies the machine gate only to a thread that runs on the CLI
  login.
- **A status that could not be read counted as signed out** for a login folder and for the
  clean login. The checker is now `makeClaudeSignedIn` in `auth/claude-login-sources.ts`: no
  answer is "unknown", and only a definite "signed out" closes a gate. The tests run the real
  checker.
- **The hosted heartbeat in token mode still read the old file.** It now reads the default
  account (`boxClaudeAuthenticated`); the clean login keeps its own answer.
- **The source scan was weak.** It now sees both quote styles, pins the count of places per
  file, and checks that the base environment names no Claude login variable. It is still a scan
  of text: a command built in a variable is not seen, and the base environment with no token is
  what protects that case.

### Review round 2 (the last round, 2026-11-23)

Four more findings, all real, all fixed:

- **A thread that the person puts on the CLI login borrowed the answer of a saved default.** The
  setup routes now give two answers for Claude: `signedIn` (the default account) and
  `machineSignedIn` (the machine's own login). The New Thread window asks the second one for a
  thread on the CLI login.
- **An unknown answer of the default account fell back to the machine's answer.** It stays
  "unknown" now. The answer of one login is never used for another.
- **The heartbeat in token mode was wrong for a CLI default.** It now reads a cached answer of
  the same checker the gates use (`makeBoxClaudeAuthenticated`), for any kind of default.
- **A place that the scan cannot see could still inherit a token** from the daemon's own
  environment. `inheritedEnv` now drops `CLAUDE_CODE_OAUTH_TOKEN`: no child gets a Claude login
  that an account did not give it. This also holds for a shell tab.

The end-to-end check was run again for the hardest install: a saved sign-in as the default, the
machine login signed out, and a token in the daemon's own environment. The setup routes said
`signedIn: true, machineSignedIn: false`; the worker gate was open; a thread and a Chat turn got
the saved sign-in; a thread on the CLI login got the machine login; no process got the daemon's
token.

The reviewer's last verdict was NO-SHIP on the commit before these fixes. No third round was
run: none of the round 2 findings was High.
