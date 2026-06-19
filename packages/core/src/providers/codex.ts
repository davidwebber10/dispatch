import type { SessionProvider } from './types.js';

export const codexProvider: SessionProvider = {
  name: 'codex',
  displayName: 'Codex',
  statusStrategy: 'pty-timing',
  buildNewCommand({ prompt }) {
    const args: string[] = [];
    if (prompt) args.push(prompt);
    return { command: 'codex', args };
  },

  buildResumeCommand({ externalSessionId }) {
    return { command: 'codex', args: ['resume', externalSessionId] };
  },
};
