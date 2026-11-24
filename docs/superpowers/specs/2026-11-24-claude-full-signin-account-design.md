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
- **A question about imports in an interactive thread.** When the person's own `CLAUDE.md` in the
  home folder imports another file, Claude Code asks once for each project, in the first
  interactive thread of the account there, whether it may load "external imports". With a login
  folder, Claude Code sees that file as a project file of every folder below the home folder.
  Dispatch does not answer that question for the person: it is a safety question. A Pretty
  thread shows no question.
- **A project folder that the person trusts later** on the computer's own login is not trusted
  for the account by that: the account asks again, once.
- **The window for a new thread** still adds an account with the token sign-in. The choice is on
  the Accounts page only.
- **A code from the full sign-in has a `#` in the middle.** A code without it is refused in plain
  words, and the sign-in stays open.
- **Two accounts of one person in two organizations** show the same mail address. The name that
  the person gives the account tells them apart.
- **A daemon that stops during a sign-in for a new account** can leave one empty folder under
  `claude-accounts`. It holds no login.

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

## 9. The check with a real sign-in (2026-11-24)

The owner signed a team account in through the page, on an isolated daemon with the real
`claude` (2.1.331). The fake home folder of that daemon had a link to the real keychain folder:
without it macOS has no keychain for the process, and Claude Code stores a login nowhere else.

| Step | Result |
| --- | --- |
| The link, the code, the account in the list | worked; the list showed "Signed in" |
| A Pretty thread on the account | listed the connectors of the team organization, 12 of them connected |
| A Pretty thread on the login of the computer, same project | listed the 10 connectors of that login: the two logins stay apart |
| The first interactive thread on the account | opened on Claude Code's first-run screen (the theme question) |
| The same after the first-run state was taken over | no first-run screen; the import question of section 5 |
| Removing the account | the keychain item of the folder was gone; the login of the computer was unchanged |

Not seen with the real command: the usage figures of the account.

**Three defects found by this check, all fixed on the branch:**

- **The wrong reason for a failed sign-in.** The first two attempts failed because the fake home
  folder had no keychain, and the page said "Claude did not accept that code". Claude Code
  2.1.331 starts its failure line with "Couldn't log in:", and Dispatch knew only the older
  "Login failed:". Dispatch now reads both. It affects a hosted box too, when its image takes a
  newer Claude Code.
- **A folder left by each failed attempt** for a new account. The folder of an attempt that ends
  with no account is deleted now.
- **The first-run screen.** After the sign-in, the folder takes over two things from the state
  file of the computer's own login (`auth/claude-account-state.ts`): that the first run is done,
  and which project folders the person trusts. Nothing else is copied. A hosted box is not
  changed.

A fourth defect is older than this change and has its own pull request: a new thread could show
the conversation of another thread (section 10).

## 10. A defect that this check showed, in older code

Two Pretty threads were made 28 seconds apart in a new project. The second showed the first
turn of the first. Cause: a thread with no session yet adopts the only transcript of its project
folder when that file is at most 60 seconds older than the thread
(`sessions/thread-transcripts.ts`, `pickRecoverableSession`). The first thread's transcript was
that file. The later, right session id of the second thread did not replace the adopted one. It
is not caused by this change: it needs only a project with one transcript.

## 11. Review round 1 (an independent Codex review, 2026-11-24)

Verdict: ship with fixes. Four findings on this change, all real, all fixed with a test:

- **Cleanup was not tied to one attempt (High).** A start that was replaced before its link came
  answered late and deleted the folder of the attempt that replaced it. And a cancel while Claude
  Code confirmed a sign-in deleted the folder, after which the confirmation still saved an
  account for it. Now an answer deletes only the folder of its own attempt, and a completion
  that arrives for a deleted folder makes no account: the folder is signed out and removed.
- **Words from stderr could reach the page (High).** The first fix of the failure reason showed
  the last line of stderr when no known failure line was there. That line can be a stack frame
  or an echo of the pasted code. Now only a known failure line is shown, as before this change
  (round 2 changed how the pasted code is kept out of it).
- **A sign-out that failed still removed the account (Medium).** The folder and the account
  went, and the login stayed in the keychain. Now Dispatch asks Claude Code after the sign-out:
  a folder that is still signed in keeps its account, and the answer says so. When Claude Code
  cannot be run at all, the removal goes on.
- **A code from a stale screen could reach the other kind of sign-in (Medium).** With two
  screens open, the second sign-in replaced the first, and the first screen could still send its
  code. The page now sends the id of its attempt with the code, and a code for another attempt
  is refused before it reaches any sign-in. This holds for every kind of sign-in.

One more change from the review: the first-run state is taken over only for a new account, not
at "Sign in again".

## 12. Review round 2 (2026-11-24)

Verdict: ship with fixes. The findings of round 1 were closed, except one that this round
widened, and one new finding came from the first fix:

- **The memory of a dropped folder held one folder only (High).** With three attempts, a second
  drop replaced the first one, and the late confirmation of the first attempt saved an account
  with no folder. Now every dropped folder is remembered with the engine of its attempt, and the
  rule is also about the folder itself: a completion whose folder is not there never makes an
  account.
- **The cut of the pasted code ran before the redaction (High).** A short half of a code that
  is part of a word could break a pattern that the redaction knows, for example "ht" in "https",
  and then a URL query stayed. Now nothing is replaced before the redaction, which is the same
  redaction as before this change. A short code that the redaction does not know, and that the
  failure line repeats, gives the fixed sentence.

Both sequences of the reviewer are tests now.

## 13. The confirm check (2026-11-24)

Both High findings of round 2 were closed. Two smaller points came from the check, both fixed:
the kind of a failure is decided by the first 160 characters of the line, as before this change,
and a new account never gets the id of a folder that was dropped. No further review round was
run.

## 14. Open before the release

1. **A real sign-in through the page**, by the owner, on an isolated daemon with the real
   `claude`: the link, the code, a thread in each mode, the connectors in that thread, the usage
   figures.
2. **Which kind is selected first** in the sheet. Built: the full sign-in.
