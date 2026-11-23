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
