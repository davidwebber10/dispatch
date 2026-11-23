import type { AccountsStore } from './accounts.js';
import { childEnv } from '../platform/inherited-env.js';
import { detectProvider } from '../setup/detect.js';

/**
 * THE source of a Claude login (docs/superpowers/specs/2026-11-23-one-claude-login-source-design.md).
 *
 * A Claude process runs on the account of its thread. A process with no thread (a Chat turn, a
 * compaction, a usage probe) runs on the default Claude account. `AccountsStore.spawnEnv` is the
 * only code that turns an account into environment variables, and it always sets
 * CLAUDE_CODE_OAUTH_TOKEN (empty for the CLI login and for a hosted account), so a process that
 * gets this overlay cannot inherit another login from the daemon's environment.
 *
 * Every place that starts `claude` and is not the thread spawner takes its login from here.
 * `tests/auth/login-sources.test.ts` holds one row per place and fails on a new one with no row.
 */
export interface ClaudeLoginSources {
  /** The account a thread runs on: its own when that account still exists, else the default. */
  accountOf(config: Record<string, unknown> | null | undefined): string;
  /** The login of an account as environment variables. No id: the default Claude account. */
  overlay(accountId?: string | null): Record<string, string>;
  /** The whole environment of a one-shot `claude` call (a title, a probe): the daemon's, the base, then the overlay. */
  processEnv(accountId?: string | null): Record<string, string>;
}

type Accounts = Pick<AccountsStore, 'spawnEnv' | 'defaultId' | 'has'>;
type SignInAccounts = Pick<AccountsStore, 'defaultId' | 'has' | 'claudeConfigDir' | 'claudeToken'>;

export function claudeLoginSources(accounts: Accounts, base: () => Record<string, string>): ClaudeLoginSources {
  const overlay = (accountId?: string | null): Record<string, string> => accounts.spawnEnv('claude-code', accountId ? { accountId } : {});
  return {
    accountOf: (config) => {
      const wanted = typeof config?.accountId === 'string' && config.accountId ? config.accountId : accounts.defaultId('claude');
      return accounts.has('claude', wanted) ? wanted : accounts.defaultId('claude');
    },
    overlay,
    processEnv: (accountId) => childEnv(base(), overlay(accountId)),
  };
}

/** "Is this Claude account signed in": true, false, or 'unknown' when the check could not answer. */
export type SignedIn = boolean | 'unknown';
let signedInSource: ((accountId?: string | null) => Promise<SignedIn>) | null = null;

/** The daemon wires this once (daemon/build.ts): how each kind of account is checked. */
export function setClaudeSignedInSource(fn: ((accountId?: string | null) => Promise<SignedIn>) | null): void { signedInSource = fn; }

/**
 * Is the Claude account signed in that a process would run on? No id: the default account. A
 * gate that asks before a thread, a title or an assist call uses this, so it answers for the
 * account that will be used, not for whichever login happens to work. Before the daemon wired a
 * source (a unit test), it is the check of the machine's own login.
 */
export async function claudeSignedIn(accountId?: string | null): Promise<SignedIn> {
  if (signedInSource) return signedInSource(accountId);
  return (await detectProvider('claude')).signedIn;
}

/**
 * The checker the daemon wires. Each kind of account has its own answer:
 * - a saved sign-in: one is stored (an expired one shows in the thread, as before);
 * - a login folder (hosted), and the primary login of a clean-login box: Claude Code's own status;
 * - the CLI login of a local install: the machine check (`setup/detect.ts`).
 * A status that could not be read is 'unknown', never false: a gate closes only on a definite
 * "signed out" (review of #189).
 */
export function makeClaudeSignedIn(d: {
  accounts: SignInAccounts;
  usesCleanLogin: () => boolean;
  cliStatus: (o?: { configDir?: string | null }) => Promise<{ loggedIn?: boolean } | null>;
  machine: () => Promise<SignedIn>;
}): (accountId?: string | null) => Promise<SignedIn> {
  const status = async (o?: { configDir?: string | null }): Promise<SignedIn> => {
    const st = await d.cliStatus(o).catch(() => null);
    return st ? st.loggedIn === true : 'unknown';
  };
  return async (accountId) => {
    const id = accountId && d.accounts.has('claude', accountId) ? accountId : d.accounts.defaultId('claude');
    if (id !== 'cli') {
      const dir = d.accounts.claudeConfigDir(id);
      return dir ? status({ configDir: dir }) : d.accounts.claudeToken(id) !== null;
    }
    if (d.usesCleanLogin()) return status();
    return d.machine().catch(() => 'unknown' as const);
  };
}

/**
 * "This box is signed in to Claude", for the hosted heartbeat, which reads it synchronously. The
 * clean login keeps its own (cached) answer. In token mode the sign-in is an account now (the old
 * single file is not written), so the answer is the same checker the gates use, for the default
 * Claude account: a stored sign-in, or the machine login when the default is the CLI login. Each
 * read gives the last known answer and starts a refresh; a check that cannot answer keeps it.
 */
export function makeBoxClaudeAuthenticated(d: { usesCleanLogin: () => boolean; cleanAuthenticated: () => boolean; signedIn: () => Promise<SignedIn> }): () => boolean {
  let known = false;
  let asking = false;
  const refresh = (): void => {
    if (asking) return;
    asking = true;
    d.signedIn().then((v) => { if (v !== 'unknown') known = v; }).catch(() => { /* keeps the last known answer */ }).finally(() => { asking = false; });
  };
  if (!d.usesCleanLogin()) refresh();
  return () => {
    if (d.usesCleanLogin()) return d.cleanAuthenticated();
    refresh();
    return known;
  };
}
