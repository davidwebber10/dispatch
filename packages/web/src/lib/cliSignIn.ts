import { api } from '../api/client';
import { useTabs } from '../stores/tabs';
import type { ProviderName } from '../api/types';

/**
 * The CLI's own sign-in (its plain login command, e.g. `codex login`): a shell thread
 * "Sign in — <Harness>" in the project, which the daemon starts with that command
 * (config.signIn). Shared by the New Thread modal's sign-in gate and the Pretty "signed out"
 * card, so there is one implementation. Resolves with the new thread's id for the caller to open.
 */
export async function startCliSignIn(sessionId: string, provider: ProviderName, harnessLabel: string): Promise<string> {
  const t = await api.createTerminal(sessionId, {
    type: 'shell',
    label: `Sign in — ${harnessLabel}`,
    config: { signIn: provider },
  });
  await useTabs.getState().loadTabs(sessionId);
  useTabs.getState().markLoading(t.id);
  return t.id;
}
