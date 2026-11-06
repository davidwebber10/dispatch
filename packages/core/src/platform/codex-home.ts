// packages/core/src/platform/codex-home.ts
// Where the Codex CLI keeps its files. Codex honors CODEX_HOME, so every reader of its login,
// sessions and archived sessions resolves through here, never through a hardcoded ~/.codex.
// Resolved per call, not at module load, so a changed environment is seen.
import os from 'os';
import path from 'path';

export function codexHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return env.CODEX_HOME || path.join(home, '.codex');
}

export function codexSessionsRoot(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(codexHome(env, home), 'sessions');
}

export function codexArchivedRoot(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(codexHome(env, home), 'archived_sessions');
}
