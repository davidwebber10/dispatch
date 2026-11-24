# A full sign-in for a Claude account (spec and build)

Date: 2026-11-24. Status: built on one branch, waits for the owner's check with a real sign-in.

## 1. The problem

A local install adds a Claude account with `claude setup-token`. That command makes a one-year
token, and Dispatch keeps it. The Claude Code documentation says about this token: "It can only
make model requests, so it can't establish Remote Control sessions or fetch claude.ai connectors."

So an added account runs the model and nothing more. A thread on it has no mail, calendar, chat
or other claude.ai connector, although the same account shows them on claude.ai. The Accounts
page has said so since 4.13.0, but the owner had no way to get the connectors for a second
account.

Measured on one install on 2026-11-24, three new threads, one for each account:

| Account | Kind of sign-in | claude.ai connector servers the thread got |
| --- | --- | --- |
| The login of the computer | full sign-in | 10 |
| An added team account | token from `setup-token` | 0 |
| The old saved sign-in | token from `setup-token` | 0 |

## 2. The proof before the build

The owner made one full sign-in to the team account with `claude auth login` in an empty folder
(`CLAUDE_CONFIG_DIR`). Then `claude mcp list` ran for that folder. It uses no model.

- The folder was signed in to the team organization. The login of the computer did not change.
- The folder listed 51 claude.ai connectors of that organization, 15 of them connected, among
  them mail, calendar, chat, drive and three that only the team organization has.
- With the links that Dispatch makes for such a folder (section 3), the result was the same.
- The folder listed no server that the person added to Claude Code at user scope: those are in
  the state file of the primary folder, which is not shared.
- After `claude auth logout` for the folder, the keychain held no item for it.

## 3. What Dispatch already had

A hosted box signs every Claude account in with `claude auth login` over pipes
(`auth/claude-cli-login.ts`). An added account there has a folder of its own,
`claude-accounts/` and its id under the data folder (`auth/claude-config-dirs.ts`). The folder
holds its own credential and its own `.claude.json`. It links `projects`, `skills`, `commands`,
`agents`, `plugins`, `settings.json` and `CLAUDE.md` to the primary folder, so a thread can
continue under another account. A thread of such an account starts with `CLAUDE_CONFIG_DIR` set
to the folder and an empty token variable. Dispatch holds no token for it.

On a local install all of this was behind one switch for the whole install
(`DISPATCH_CLAUDE_LOGIN=cli`).

## 4. The change

A local install keeps the token sign-in for everything it did before. One thing is added: an
account can be signed in with a folder of its own.

- **The sign-in service** (`auth/claude-login.ts`): `useFolderLogin` gives a local install the
  same `claude auth login` engine. `startForAccount` takes `folder: true`. The status, the pasted
  code and a cancel go to the attempt that is in flight. One attempt ends the other: there is one
  sign-in at a time, as before.
- **The routes** (`routes/accounts.ts`): `POST /api/accounts/claude/login` takes
  `kind: "folder"` for a new account. "Sign in again" follows the kind of the account, whatever
  the request says. `GET /api/accounts` says `claudeFullSignIn` when the install offers it, and
  gives the sign-in state of a folder account. Removing a folder account runs
  `claude auth logout` for the folder first: on macOS the credential is in the keychain, so
  deleting the folder alone would leave it there.
- **Usage figures** (`daemon/wire-limits.ts`): a folder account has no token to read usage with.
  Its figures come from Claude Code's own `get_usage` request, with no model turn, as on a hosted
  box.
- **The page** (Settings, Accounts): the sheet for a new Claude account has two kinds. "Full
  sign-in" is first and selected: it keeps the claude.ai connectors. "Model only" is the sign-in
  that Dispatch keeps. The page of a folder account says that it has the connectors of that
  account, shows "Signed in" or "Not signed in", and offers the sign-in again when it is signed
  out.

Nothing else changes. Threads, Chat, titles and the checks already take the login from the
account (4.13.0), and a folder account is one more kind that this source knows. A hosted box
behaves as before: it has no token sign-in, and the new kind in a request changes nothing there.

## 5. Limits

- **Servers added to Claude Code at user scope** (`claude mcp add` with user scope) are not in a
  folder account. Integrations that Dispatch gives a thread still come.
- **The first interactive thread of a folder account** can show Claude Code's own first-run
  questions, for example whether it may trust the project folder. The answer is kept in the
  folder of the account.
- **The window for a new thread** still adds an account with the token sign-in. The choice is on
  the Accounts page only.
- **A code from the full sign-in has a `#` in the middle.** A code without it is refused in plain
  words, and the sign-in stays open.
- **Two accounts of one person in two organizations** show the same mail address. The name that
  the person gives the account tells them apart.

## 6. Tests

- The service: the folder sign-in for a new account and for "Sign in again"; one attempt ends the
  other; the sign-in state of a folder; the sign-out of a folder; the refusal when no engine is
  wired (`auth/claude-cli-login.test.ts`).
- The routes: the kind in the request, the kind of an existing account, the refusal, the hosted
  case, the list, and the removal order (`tests/routes/accounts-folder.test.ts`).
- The page: the two kinds, what each one starts, a daemon that does not offer it, the connector
  line, and the signed-out state (`AccountsSection.test.tsx`).

## 7. Roll back

A revert of the release. A folder account stays in `accounts.json` with its folder. Older code
lists it and starts its threads with the folder, as a hosted box does, but cannot sign it in
again on a local install. Remove the account on the Accounts page before the revert, or sign the
folder out with `claude auth logout` and `CLAUDE_CONFIG_DIR` set to the folder.

## 8. Build record (2026-11-24)

Three commits: the service, the routes with the daemon wiring, the page.

The end-to-end check, on an isolated daemon with a stand-in `claude` that plays
`claude auth login`, `auth status` and `auth logout` and records which login each process got:

| Step | Result |
| --- | --- |
| The list of a new install | offers the full sign-in |
| A code with no `#` | refused in plain words, the sign-in stays open |
| The whole code | complete; the account has a folder and no token; the folder has mode 700 and the shared links |
| A thread on the new account, and its title | got the folder of the account |
| A thread with no account | got the login of the computer: the default did not change |
| The usage figures of the new account | one `get_usage` request with the folder, no model turn |
| After "make default": a new thread and a Chat turn | got the folder of the account |
| Removing the account | `claude auth logout` ran for the folder, then the folder was deleted |

No token text reached the daemon log.

## 9. Open before the release

1. **A real sign-in through the page**, by the owner, on an isolated daemon with the real
   `claude`: the link, the code, a thread in each mode, the connectors in that thread, the usage
   figures.
2. **Which kind is selected first** in the sheet. Built: the full sign-in.
