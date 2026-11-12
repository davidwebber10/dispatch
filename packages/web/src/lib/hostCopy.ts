// Plain wording on a hosted workspace (Dispatch inside Polywood OS, 2026-11).
//
// A person on a hosted workspace never sees machine words: container, box, daemon, server restart,
// PTY, Tailscale, pairing, localhost, `git pull`. Each such sentence in the page goes through
// `hostCopy(key, local)`: on a local install it returns `local` (the old sentence, unchanged); on a
// hosted workspace it returns the plain sentence below. A developer on a hosted box may get the
// technical sentence too, through `hostDetail()` (shown under the plain line).
//
// === AGENT NOTES ===
// - Add a key to PLAIN, then replace the literal at its call site with `hostCopy('<key>', '<old text>')`.
//   The old text stays at the call site so the local install is byte for byte the same.
// - Name the product with PRODUCT_NAME, never a literal, so a rename is one line.
import { realHostContext, usesPlainWording } from './hostContext';

/** The product's name in every hosted sentence and in the page title. A rename is this one line. */
export const PRODUCT_NAME = 'Dispatch';

/** The platform the workspace belongs to, for the way back. */
export const PLATFORM_NAME = 'POLYWOOD OS';

/** EDIT HERE: the plain sentence for each machine sentence. */
export const PLAIN = {
  'conn.connecting': 'Connecting…',
  'conn.reconnecting': 'Your workspace is reconnecting…',
  'conn.closed': 'Your workspace is offline',
  'conn.serverLabel': 'Workspace',
  'update.progress.title': 'Your workspace is updating',
  'update.progress.restarting': `Your workspace is updating — this takes about a minute.`,
  'update.progress.body': 'This page comes back by itself when the update is done.',
  'update.available': 'An update is ready',
  'update.check.hint': 'Looks for a newer version.',
  'update.check.unreachable': 'Could not check for updates right now.',
  'update.apply.hint': 'Your workspace updates, and this page comes back by itself.',
  'update.failed.hint': 'Your workspace could not update just now. Try again in a few minutes. If it keeps failing, ask your administrator.',
  'update.done.body': 'The update is ready. Reload to use it.',
  'update.step.restart': 'Finishing',
  'thread.interrupted': 'Your workspace restarted during the last turn, so the turn stopped.',
  'thread.reconnecting': 'Reconnecting…',
  'thread.why.none': 'No explanation is available. Try again in a moment.',
  'thread.why.noEvents': 'Nothing was recorded for this thread yet.',
  'settings.group.machine': 'THIS WORKSPACE',
  'settings.save.failed': 'Could not save. Try again in a moment.',
  'accounts.load.failed': 'Could not load the accounts. Try again in a moment.',
  'accounts.cli.description': 'The sign-in that your workspace uses by default. You can rename it.',
  'accounts.cli.hint': 'your workspace',
  'accounts.cli.placeholder': 'Default sign-in',
  'accounts.usage.signInCli': 'Sign in again to see usage for this account.',
  'accounts.none': 'No other accounts are available yet.',
  'chat.settings.unavailable': 'Chat settings are not available right now.',
  'brand.version': 'Version',
} as const;

export type HostCopyKey = keyof typeof PLAIN;

/** The sentence for this page: `local` on a local install, the plain sentence on a hosted workspace. */
export function hostCopy(key: HostCopyKey, local: string): string {
  return usesPlainWording() ? PLAIN[key] : local;
}

/**
 * The technical detail to show UNDER a plain line: on a hosted workspace for a developer only.
 * Null when there is nothing to add (a local install already shows `local` as the main line).
 */
export function hostDetail(local: string): string | null {
  const ctx = realHostContext();
  return usesPlainWording() && ctx.profile === 'developer' && ctx.hosted ? local : null;
}

/** The daemon's stock name of the CLI login (core/src/auth/accounts.ts CLI_LABEL). */
export const STOCK_CLI_ACCOUNT_LABEL = 'CLI login (this computer)';

/**
 * An account's name as the page shows it. With plain wording the CLI login's stock name ("CLI login
 * (this computer)") becomes "Your Claude account" / "Your Codex account"; a name the person chose stays.
 */
export function accountDisplayLabel(provider: 'claude' | 'codex', label: string, isCli: boolean): string {
  if (!isCli || label !== STOCK_CLI_ACCOUNT_LABEL || !usesPlainWording()) return label;
  return provider === 'claude' ? 'Your Claude account' : 'Your Codex account';
}
