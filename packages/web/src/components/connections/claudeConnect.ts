import { create } from 'zustand';

/**
 * The "Connect your Claude account" step must show ONCE on a screen. Two places can offer it: the
 * workspace prompt (setup/ConnectAccountPrompt, a business person's first run) and the card above a
 * chat thread's composer (connections/ConnectClaudeCard). The card counts itself here while it is on
 * screen; the prompt hides meanwhile. Both run the same login (endless/ClaudeLogin → /api/claude-auth).
 */
export const useClaudeConnect = create<{ cards: number; connected: boolean }>(() => ({ cards: 0, connected: false }));

export function claudeCardShown(): () => void {
  useClaudeConnect.setState((s) => ({ cards: s.cards + 1 }));
  return () => useClaudeConnect.setState((s) => ({ cards: Math.max(0, s.cards - 1) }));
}

/** The login finished (from either place): every offer of the step goes away. */
export function claudeConnected(): void {
  useClaudeConnect.setState({ connected: true });
}
