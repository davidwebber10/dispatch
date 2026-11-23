import { create } from 'zustand';

/**
 * A sign-in finished for an account (the Sign in on a "signed out" card, or "Sign in again" in Settings).
 * A signed-out card of that account, in any thread, then says "Signed in" with a Retry button instead of
 * asking for a sign-in again, when the sign-in is newer than the failure the card shows (the daemon puts
 * the failure time on the frame). Not saved: a reload shows the real state from the daemon.
 */
export const signInKey = (provider: string, accountId?: string): string => `${provider}:${accountId || 'cli'}`;

interface State {
  /** When each account's last sign-in finished (epoch ms). */
  at: Record<string, number>;
  mark: (provider: string, accountId?: string) => void;
}

export const useSignInRecovered = create<State>((set) => ({
  at: {},
  mark: (provider, accountId) => set((s) => ({ at: { ...s.at, [signInKey(provider, accountId)]: Date.now() } })),
}));
