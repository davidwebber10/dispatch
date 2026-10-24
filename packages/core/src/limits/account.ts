// packages/core/src/limits/account.ts
// Which login a provider CLI is signed in with right now, so a limit figure from one account is
// never shown as current after the owner switches to another. Reads the CLI's own local files.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

const cache = new Map<string, { sig: string; id: string }>();

function readId(file: string, pick: (json: any) => unknown): string {
  try {
    const st = fs.statSync(file);
    const sig = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(file);
    if (hit?.sig === sig) return hit.id;
    const v = pick(JSON.parse(fs.readFileSync(file, 'utf-8')));
    const id = typeof v === 'string' ? v : '';
    cache.set(file, { sig, id });
    return id;
  } catch { return ''; }
}

/** Claude Code: `oauthAccount.accountUuid` in `.claude.json`. '' when it cannot be told. */
export function claudeAccountId(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const file = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json');
  return readId(file, (j) => j?.oauthAccount?.accountUuid ?? j?.oauthAccount?.emailAddress);
}

/** Codex: `tokens.account_id` in `auth.json`. '' when it cannot be told. */
export function codexAccountId(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const file = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'auth.json');
  return readId(file, (j) => j?.tokens?.account_id);
}

export function accountIdFor(provider: string): string {
  return provider === 'claude-code' ? claudeAccountId() : provider === 'codex' ? codexAccountId() : '';
}

/** A headless box signs in with an injected token, not the CLI's own file: the account is that token (hashed, never stored raw). */
export function tokenAccountId(token: string | null | undefined): string {
  return token ? `token:${createHash('sha256').update(token).digest('hex').slice(0, 16)}` : '';
}

/** When the Codex login file was last written: figures a Codex session file holds from before that may belong to another account. */
export function codexLoginChangedAt(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): number {
  try { return fs.statSync(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'auth.json')).mtimeMs; } catch { return 0; }
}
