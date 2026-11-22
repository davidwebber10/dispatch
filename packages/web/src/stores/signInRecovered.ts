import { create } from 'zustand';

/**
 * A sign-in finished for an account (the Sign in on a "signed out" card, or "Sign in again" in Settings).
 * Every standing signed-out card of that account, in any thread, then says "Signed in" with a Retry
 * button instead of asking for a sign-in again. Not saved: a reload shows the real state from the daemon.
 */
export const signInKey = (provider: string, accountId?: string): string => `${provider}:${accountId || 'cli'}`;

interface State {
  /** A count of finished sign-ins; each account keeps the count of its last one (the clock can tie, a count cannot). */
  seq: number;
  at: Record<string, number>;
  mark: (provider: string, accountId?: string) => void;
}

export const useSignInRecovered = create<State>((set) => ({
  seq: 0,
  at: {},
  mark: (provider, accountId) => set((s) => ({ seq: s.seq + 1, at: { ...s.at, [signInKey(provider, accountId)]: s.seq + 1 } })),
}));
