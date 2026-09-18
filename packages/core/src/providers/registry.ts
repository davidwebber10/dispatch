import { isAgentType, type AgentType } from './agent-types.js';
import type { SessionProvider } from './types.js';
import { claudeCodeProvider } from './claude-code.js';
import { codexProvider } from './codex.js';
import { grokProvider } from './grok.js';
import { opencodeProvider } from './opencode.js';

const providers: Record<AgentType, SessionProvider> = {
  'claude-code': claudeCodeProvider,
  'codex': codexProvider,
  'grok': grokProvider,
  'opencode': opencodeProvider,
};

export function getProvider(name: string): SessionProvider {
  if (!isAgentType(name)) throw new Error(`Unknown provider: ${name}`);
  const provider = providers[name];
  return provider;
}

export function listProviders(): SessionProvider[] {
  return Object.values(providers);
}

/** Resolve hook aliases only when a registered harness explicitly owns them. */
export function providerForHook(name: string): SessionProvider | undefined {
  return listProviders().find((p) => p.telemetry.hookNames.includes(name));
}
