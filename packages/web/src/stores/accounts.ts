import { create } from 'zustand';
import { api } from '../api/client';
import type { Account, AccountsView, AccountProvider, Terminal, UsageAccessState } from '../api/types';

/**
 * The signed-in accounts per harness (multi-account, 2026-11-06), loaded once on first use and
 * reloaded on demand (after an add, a remove, a switch). `view` stays null against a daemon that
 * has no accounts route, and every account-aware control then renders nothing.
 */
interface AccountsState {
  view: AccountsView | null;
  loading: boolean;
  load: () => Promise<void>;
  reload: () => Promise<void>;
}

export const useAccounts = create<AccountsState>((set, get) => ({
  view: null,
  loading: false,
  load: async () => { if (get().view || get().loading) return; await get().reload(); },
  reload: async () => {
    set({ loading: true });
    try { set({ view: await api.getAccounts() }); } catch { /* older daemon: no accounts */ }
    finally { set({ loading: false }); }
  },
}));

/** The harness a thread type's accounts belong to, or null for a thread type with no accounts. */
export function accountProviderOf(type: string): AccountProvider | null {
  return type === 'claude-code' ? 'claude' : type === 'codex' ? 'codex' : null;
}

/**
 * Which account a thread runs on: the pinned one, else the harness default (an unpinned thread
 * takes the default at spawn time). Null when the thread has no accounts or the list is not loaded.
 */
export function threadAccount(view: AccountsView | null, tab: Pick<Terminal, 'type' | 'config'> | null | undefined): { id: string; label: string; pinned: boolean } | null {
  if (!view || !tab) return null;
  const provider = accountProviderOf(tab.type);
  if (!provider) return null;
  const pinned = typeof tab.config?.accountId === 'string' ? (tab.config.accountId as string) : null;
  const id = pinned && view[provider].some((a) => a.id === pinned) ? pinned : view.defaults[provider] ?? 'cli';
  const account = view[provider].find((a) => a.id === id);
  return { id, label: account?.label ?? id, pinned: pinned === id };
}

/** The short name shown beside a thread: "Work", or "CLI login" for the CLI's own login. */
export function shortAccountLabel(label: string): string {
  return label.replace(/\s*\(this computer\)$/, '');
}

// --- usage access (W1-H, 2026-11-09) -----------------------------------------------------------

/** The words for each state, the same on the usage card and in Settings → Accounts. */
export const USAGE_ACCESS_TEXT = {
  signIn: 'Sign in again to see usage for this account',
  signInCli: "Sign in again on the daemon's computer to see usage for this account: run claude there.",
  notAvailable: 'This sign-in can run threads. It cannot read usage figures.',
} as const;

/** "Updated 12 min ago" for a time in the past; hours from two hours on. */
export function updatedAgo(at: number, now: number): string {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 1) return 'Updated just now';
  if (min < 120) return `Updated ${min} min ago`;
  return `Updated ${Math.round(min / 60)} h ago`;
}

/** An account's usage access when it needs a word on the card: null for `ok`, not known, or an older daemon. */
export function usageAccessOf(a: Pick<Account, 'usageAccess'> | null | undefined): { state: Exclude<UsageAccessState, 'ok'>; lastOkAt: number | null } | null {
  const u = a?.usageAccess;
  if (!u || u.state === 'ok') return null;
  if (u.state !== 'sign-in-needed' && u.state !== 'not-available' && u.state !== 'rate-limited') return null;
  return { state: u.state, lastOkAt: typeof u.lastOkAt === 'number' ? u.lastOkAt : null };
}
