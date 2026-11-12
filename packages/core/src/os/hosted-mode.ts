// packages/core/src/os/hosted-mode.ts
// The switches that make a daemon behave as a HOSTED box (provisioned by POLYWOOD OS). Each one is
// on when the box is hosted (OS_BASE_URL + OS_BOX_TOKEN, update/hosted.ts) and can be turned on by
// itself on a local install to try it. With none of these variables set, a local daemon is unchanged.
import { hostedTarget } from '../update/hosted.js';

/** True on a box OS provisioned. */
export function isHostedBox(env: NodeJS.ProcessEnv = process.env): boolean {
  return hostedTarget(env) !== null;
}

/**
 * The clean Claude login (`claude auth login`, no token in the daemon): on a hosted box, or with
 * DISPATCH_CLAUDE_LOGIN=cli. DISPATCH_CLAUDE_LOGIN=token keeps the setup-token login even when hosted.
 */
export function useCleanClaudeLogin(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.DISPATCH_CLAUDE_LOGIN?.trim().toLowerCase();
  if (v === 'cli') return true;
  if (v === 'token') return false;
  return isHostedBox(env);
}

/** The hosted continuity behaviours (resume ordinary chat threads after a restart): hosted, or DISPATCH_RESUME_CHATS=1. */
export function resumeChatsAfterRestart(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.DISPATCH_RESUME_CHATS?.trim();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return isHostedBox(env);
}

/** Usage figures without the token (stream events + one get_usage probe): hosted, or the clean login. */
export function usageWithoutToken(env: NodeJS.ProcessEnv = process.env): boolean {
  return useCleanClaudeLogin(env);
}
