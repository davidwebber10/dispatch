// The daemon-enforced authority policy for scheduled roles (see
// docs/superpowers/specs/2026-09-02-scheduled-roles-design.md §5). A role-runner variant of
// coordinator-policy.ts: same mechanism (consulted by the structured manager's can_use_tool
// membrane on every tool call), same "deny every ambiguous command form; allow only explicit
// forms whose target is textually visible" trick, but keyed off the role's own
// `authority: observe | stage | stage-deploy` frontmatter instead of a fixed coordinator ruleset.
// Deny messages teach: each one names what the role should do instead, so a denial redirects
// rather than dead-ends a run.
import { ROLE_AUTHORITIES, type RoleAuthority } from './definition.js';

export type PolicyDecision = { allow: true } | { allow: false; message: string };

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const AGENT_MSG =
  'Role policy: role runners never spawn native subagents (Agent/Task) — do the work directly ' +
  "and record what you could not finish in this run's report.";

const observeOnlyMsg = (action: string) =>
  `Role policy: this role has authority: observe — report it instead of ${action}; an ` +
  'observe-only role never mutates anything.';

const BARE_PUSH_MSG =
  'Role policy: git push needs an explicit target — run `git push <remote> <branch>`; a bare ' +
  'or remote-only push is refused as ambiguous.';

const PROTECTED_PUSH_MSG =
  'Role policy: main/production mutations are explicit human approval only — stage a PR against ' +
  'a feature branch instead of pushing to main/master/prod*.';

const PR_MERGE_MSG =
  'Role policy: gh pr merge is never automated — main/production mutations are explicit human ' +
  'approval only; open or update the PR and let a human merge it.';

const SHIP_MSG =
  'Role policy: releases, publishes, and infrastructure applies (gh release, npm/pnpm/yarn ' +
  'publish, dispatch update/release, terraform apply/destroy) are explicit human approval only ' +
  '— stage the change and report it instead.';

const WORKFLOW_PROD_MSG =
  'Role policy: production deploys are explicit human approval only — stage the work and leave ' +
  'the deploy decision in your report.';

const WORKFLOW_AMBIGUOUS_MSG =
  'Role policy: gh workflow run must name its target explicitly (-f environment=staging) — an ' +
  'ambiguous run is refused (deny-when-ambiguous).';

const WORKFLOW_NEEDS_STAGE_DEPLOY_MSG =
  "Role policy: staging deploys need authority: stage-deploy in the role's frontmatter — this " +
  'role cannot run gh workflow run at its current authority.';

const PUSH_UNCLASSIFIABLE_MSG =
  'Role policy: could not verify the push target — use the plain form `git push <remote> <branch>` ' +
  '(no quoted arguments); main/production stay human-approval-only.';

// Tolerates a run of leading flags/options before the subcommand, including flags whose value
// is a separate token (`-C ../wt`, `-c user.email=x`, `-R owner/repo`), so an interposed flag
// can't be used to slip a blocked subcommand past the check. Same technique as coordinator-policy.ts.
const FLAGS = '(?:-\\S+(?:\\s+\\S+)?\\s+)*';
const GIT_PUSH_RE = new RegExp(`\\bgit\\s+${FLAGS}push\\b(.*)`);
const GIT_COMMIT_RE = new RegExp(`\\bgit\\s+${FLAGS}commit\\b`);
const GH_PR_MERGE_RE = new RegExp(`\\bgh\\s+${FLAGS}pr\\s+${FLAGS}merge\\b`);
const GH_PR_CREATE_RE = new RegExp(`\\bgh\\s+${FLAGS}pr\\s+${FLAGS}create\\b`);
const GH_WORKFLOW_RUN_RE = new RegExp(`\\bgh\\s+${FLAGS}workflow\\s+${FLAGS}run\\b`);
const GH_RELEASE_RE = new RegExp(`\\bgh\\s+${FLAGS}release\\b`);
const PUBLISH_RE = new RegExp(`\\b(npm|pnpm|yarn)\\s+${FLAGS}publish\\b`);
const DISPATCH_RE = /\bdispatch\s+(update|release)\b/;
const TERRAFORM_RE = /\bterraform\s+(apply|destroy)\b/;
const PROTECTED_BRANCH_RE = /^(main|master|prod)/i;
// git's own dst-disambiguation for a push refspec: an unprefixed `heads/<name>` resolves to
// `refs/heads/<name>` exactly as `refs/heads/<name>` itself does (verified against a live bare
// repo) — so normalization strips ONE leading `refs/` (if present), then ONE leading `heads/`
// (if present), mirroring that resolution order. `tags/<name>` and `remotes/<remote>/<name>`
// deliberately do NOT get a `heads/`-equivalent strip: git resolves those to a different ref
// namespace entirely (a tag or a remote-tracking ref, not a branch), so `tags/main` is not
// branch `main`.
const LEADING_REFS_RE = /^refs\//i;
const LEADING_HEADS_RE = /^heads\//i;
const ENV_PRODUCTION_RE = /environment=production\b/;
const ENV_STAGING_RE = /environment=staging\b/;

// A single `.test(cmd)`/`.match(cmd)` against the WHOLE command string is safe for a rule that
// is a pure denial (pr merge, release, publish, dispatch, terraform, commit, pr create) — those
// never produce an "allow" verdict, so it doesn't matter whether the match is the first or the
// third `&&`-chained clause; if the pattern appears anywhere, the command is denied. It is NOT
// safe for git-push / gh-workflow-run: those rules can also decide something is explicitly FINE
// (a non-protected push, a staging-only workflow run at stage-deploy), and a naive whole-string
// scan only ever inspects the FIRST occurrence — a chained `git push origin main && gh workflow
// run ... environment=staging` would let the first clause's "fine" verdict answer for the whole
// command, silently skipping the protected-branch push in the second clause. Both push and
// workflow-run checks below therefore split the command into shell-separated segments (`&&`,
// `;`, `|`) and evaluate every segment; the deny loop in evaluateBash then runs ALL rules to
// completion before it is ever allowed to return `{ allow: true }` (see evaluateBash's own
// comment) — the two defenses compose so no chained command can smuggle a denied half past an
// earlier allow.
// Quote-aware: `&&`, `;`, `|` split a command into segments ONLY when they appear outside a
// quoted string — `git push -o "release notes: build && deploy" origin main` is one segment,
// not two, so the push's real positional args (`origin main`) can't be torn apart from its
// `git push` prefix by an `&&` sitting inside a quoted flag value (that was exactly how the
// false-ALLOW happened: a naive regex split cut the command mid-string, leaving a first half
// that "looked like" an ambiguous-but-harmless push and a second half with no `git push` prefix
// left to match at all — the real target, `main`, went unseen by every check). A command with
// an UNBALANCED quote (no matching close) can't be split with any confidence about where a
// segment really ends, so it fails closed: treated as a single segment containing the whole
// original string, same as an unparseable input — better to over-deny than to silently drop
// half a command on the floor.
function segments(cmd: string): string[] {
  const result: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '&' && cmd[i + 1] === '&') {
      result.push(current);
      current = '';
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '|') {
      result.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (inSingle || inDouble) return [cmd]; // unbalanced quote — fail closed, don't trust any split
  result.push(current);
  return result;
}

/** The remote-side ref of a `<local>:<remote>` refspec token — e.g. `feature:main` targets
 *  remote branch `main` even though the local branch pushed is `feature`; a check that tests
 *  the raw token is fooled by the local half masking the real target. A leading `+` (force-push
 *  shorthand — `+feature:main`, or `+main` alone) prefixes the WHOLE refspec, not the remote
 *  half, so it's stripped before splitting on `:`. A token with no colon (`git push origin
 *  main`) has no separate local/remote pair — the token IS the remote ref. Git also accepts the
 *  fully-qualified form (`refs/heads/main`, `feature:refs/heads/main`) and git's own
 *  dst-disambiguation of the unprefixed `heads/main` form as fully equivalent to the short
 *  branch name — `refs/heads/main`, `heads/main`, and `main` are the same ref — so one leading
 *  `refs/` is stripped (case-insensitively), then one leading `heads/` (case-insensitively),
 *  before the protected-branch test runs. */
function remoteRefOf(token: string): string {
  const t = token.startsWith('+') ? token.slice(1) : token;
  const idx = t.indexOf(':');
  const ref = idx === -1 ? t : t.slice(idx + 1);
  return ref.replace(LEADING_REFS_RE, '').replace(LEADING_HEADS_RE, '');
}

// A push flag we can confidently say never redirects or hides the `<remote> <branch>`
// positionals — pure boolean switches, no attached value, no aliasing effect on argv shape.
// Anything NOT in this set (most importantly a flag that might take a separate-token value,
// like `-o`/`--push-option`, `--repo`, `--receive-pack`) is refused outright rather than
// guessed at: we cannot tell, from text alone, whether such a flag consumes the next token as
// its value or leaves it as a positional, so trying to classify it either way is a guess — and
// a wrong guess in the "leaves it positional" direction is exactly how a hidden flag value
// could impersonate `<remote>` or masquerade as `<branch>`.
const PUSH_SAFE_FLAGS = new Set([
  '-f', '--force', '-u', '--set-upstream', '--tags', '-n', '--dry-run',
  '-d', '--delete', '--no-verify', '-q', '--quiet', '-v', '--verbose',
]);

/** `git push` gets a STRICT-SHAPE ALLOW, not a denylist: a push-shaped segment (matches
 *  GIT_PUSH_RE) is allowed ONLY when every part of it can be confidently classified — no quote
 *  characters anywhere in the segment (a quoted argument can hide arbitrary shell-meaningful
 *  text, including a `&&` that would otherwise have split the command), every flag token in
 *  PUSH_SAFE_FLAGS, and EXACTLY two positional tokens (`<remote> <branch-or-refspec>` — neither
 *  fewer, which is an ambiguous/bare push, nor more, which means some token wasn't accounted
 *  for by the flags we understood). Anything that fails any of those tests is refused with
 *  PUSH_UNCLASSIFIABLE_MSG, not passed through: a false DENY here just redirects the runner to
 *  the plain `git push <remote> <branch>` form; a false ALLOW ships to main at 3am. Evaluated
 *  per-segment (see the comment above segments()) so every push in a chained command is
 *  checked, not just the first. Returns a deny, or null if this segment has no push this rule
 *  objects to (never an explicit allow — the caller decides "no deny anywhere" for itself). */
function checkGitPush(cmd: string, authority: RoleAuthority): PolicyDecision | null {
  for (const segment of segments(cmd)) {
    const m = segment.match(GIT_PUSH_RE);
    if (!m) continue;

    if (segment.includes('"') || segment.includes("'")) return { allow: false, message: PUSH_UNCLASSIFIABLE_MSG };

    const tokens = m[1].trim().split(/\s+/).filter(Boolean);
    const flags = tokens.filter((t) => t.startsWith('-'));
    const positional = tokens.filter((t) => !t.startsWith('-'));
    if (flags.some((f) => !PUSH_SAFE_FLAGS.has(f))) return { allow: false, message: PUSH_UNCLASSIFIABLE_MSG };
    if (positional.length < 2) return { allow: false, message: BARE_PUSH_MSG };
    if (positional.length > 2) return { allow: false, message: PUSH_UNCLASSIFIABLE_MSG };

    const remoteRef = remoteRefOf(positional[1]);
    if (PROTECTED_BRANCH_RE.test(remoteRef)) return { allow: false, message: PROTECTED_PUSH_MSG };
    if (authority === 'observe') return { allow: false, message: observeOnlyMsg('pushing') };
  }
  return null;
}

/** `gh workflow run` is denied whenever its target is invisible or dangerous (no environment=
 *  flag at all, or environment=production), regardless of authority — and denied at every
 *  authority below stage-deploy even when it does explicitly name environment=staging, since
 *  only stage-deploy carries deploy authority. Evaluated per-segment for the same chaining
 *  reason as checkGitPush. Returns a deny, or null if no segment's workflow run is objectionable. */
function checkWorkflowRun(cmd: string, authority: RoleAuthority): PolicyDecision | null {
  for (const segment of segments(cmd)) {
    if (!GH_WORKFLOW_RUN_RE.test(segment)) continue;
    const hasProduction = ENV_PRODUCTION_RE.test(segment);
    const hasStaging = ENV_STAGING_RE.test(segment);
    if (authority === 'stage-deploy' && hasStaging && !hasProduction) continue; // explicitly fine — check the rest
    if (hasProduction) return { allow: false, message: WORKFLOW_PROD_MSG };
    if (!hasStaging) return { allow: false, message: WORKFLOW_AMBIGUOUS_MSG };
    return { allow: false, message: WORKFLOW_NEEDS_STAGE_DEPLOY_MSG };
  }
  return null;
}

function checkPrMerge(cmd: string): PolicyDecision | null {
  return GH_PR_MERGE_RE.test(cmd) ? { allow: false, message: PR_MERGE_MSG } : null;
}
function checkRelease(cmd: string): PolicyDecision | null {
  return GH_RELEASE_RE.test(cmd) ? { allow: false, message: SHIP_MSG } : null;
}
function checkPublish(cmd: string): PolicyDecision | null {
  return PUBLISH_RE.test(cmd) ? { allow: false, message: SHIP_MSG } : null;
}
function checkDispatchCli(cmd: string): PolicyDecision | null {
  return DISPATCH_RE.test(cmd) ? { allow: false, message: SHIP_MSG } : null;
}
function checkTerraform(cmd: string): PolicyDecision | null {
  return TERRAFORM_RE.test(cmd) ? { allow: false, message: SHIP_MSG } : null;
}
function checkCommit(cmd: string, authority: RoleAuthority): PolicyDecision | null {
  if (authority !== 'observe') return null; // git commit is fine at stage / stage-deploy
  return GIT_COMMIT_RE.test(cmd) ? { allow: false, message: observeOnlyMsg('committing') } : null;
}
function checkPrCreate(cmd: string, authority: RoleAuthority): PolicyDecision | null {
  if (authority !== 'observe') return null; // gh pr create is fine at stage / stage-deploy
  return GH_PR_CREATE_RE.test(cmd) ? { allow: false, message: observeOnlyMsg('opening a PR') } : null;
}

// Every rule that can deny a Bash command, run against the WHOLE command in this fixed order.
// evaluateBash below runs every one of these to completion; only if NONE of them found anything
// to deny does it fall through to `{ allow: true }`. No entry in this list is allowed to
// short-circuit the ones after it with an early "allow" — see the block comment above checkGitPush.
const BASH_DENY_CHECKS: ReadonlyArray<(cmd: string, authority: RoleAuthority) => PolicyDecision | null> = [
  checkWorkflowRun,
  checkGitPush,
  checkPrMerge,
  checkRelease,
  checkPublish,
  checkDispatchCli,
  checkTerraform,
  checkCommit,
  checkPrCreate,
];

function evaluateBash(cmd: string, authority: RoleAuthority): PolicyDecision {
  for (const check of BASH_DENY_CHECKS) {
    const denial = check(cmd, authority);
    if (denial) return denial;
  }
  return { allow: true }; // reached only once every deny rule above has cleared the WHOLE command
}

/** Builds the per-call policy function for one role's authority level. Pure — no I/O, no state.
 *  `authority` arrives from role.md frontmatter via `config.roleAuthority`, which is untyped
 *  (`Record<string, any>`) at the sessions/service.ts call site — validate it here rather than
 *  trust the cast, and fail CLOSED: an unrecognized value (a future authority level this build
 *  doesn't know yet, a hand-edited role.md, a corrupted config) gets the most restrictive
 *  policy, never the loosest. */
export function roleToolPolicy(authority: RoleAuthority): (toolName: string, input: unknown) => PolicyDecision {
  const effective: RoleAuthority = (ROLE_AUTHORITIES as readonly string[]).includes(authority) ? authority : 'observe';

  return function rolePolicy(toolName: string, input: unknown): PolicyDecision {
    if (toolName === 'Agent' || toolName === 'Task') return { allow: false, message: AGENT_MSG };

    if (FILE_TOOLS.has(toolName)) {
      if (effective === 'observe') return { allow: false, message: observeOnlyMsg('writing a file') };
      return { allow: true }; // stage / stage-deploy: writes allowed anywhere in the project
    }

    if (toolName !== 'Bash') return { allow: true };

    const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const cmd = typeof inp.command === 'string' ? inp.command : '';

    return evaluateBash(cmd, effective);
  };
}
