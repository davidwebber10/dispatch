import type { SessionProvider } from './types.js';
import { claudeCodeProvider } from './claude-code.js';
import { codexProvider } from './codex.js';

const providers: Record<string, SessionProvider> = {
  'claude-code': claudeCodeProvider,
  'codex': codexProvider,
};

export function getProvider(name: string): SessionProvider {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  return provider;
}

export function listProviders(): SessionProvider[] {
  return Object.values(providers);
}
