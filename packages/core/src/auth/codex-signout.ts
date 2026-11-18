// packages/core/src/auth/codex-signout.ts
// Sign the CLI's own Codex login out on a hosted box (capability `codex-signout-v1`): the person may
// leave their ChatGPT account whenever they want, from the Connections page.
//
//   1. A Codex thread that is working (or waits for the person) refuses it, in plain words: its turn
//      would fail half way.
//   2. Every live Codex chat thread is ended. They share one app-server, which holds the login in
//      memory; a thread starts again (signed out) on its next message.
//   3. `codex logout` runs in the login's CODEX_HOME. Under privilege separation the spawn guard runs
//      it as the agent user, who owns the file. If auth.json is still there after it, the agent
//      removes the file itself (what `codex logout` does).
//   4. The usage figures of that login are forgotten.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { agentNode } from '../privsep/agent-fs.js';

export type CodexSignOutResult = { ok: true; signedIn: false } | { ok: false; status: 409 | 500; error: string };

export interface CodexSignOutDeps {
  /** The login's folder (CODEX_HOME of the CLI login). */
  home: string;
  /** The env `codex` runs with (the threads' spawn env); CODEX_HOME is added. */
  env: () => Record<string, string | undefined>;
  /** The title of a Codex thread that is working or waits for the person, or null when none. */
  busyThread: () => string | null;
  /** End every live Codex chat thread (they start again on their next message). */
  stopThreads: () => void;
  /** Forget the usage figures of this login. */
  forgetUsage: () => void;
  /** Run `codex logout` (tests). */
  runLogout?: (env: Record<string, string>) => Promise<void>;
  /** Remove auth.json as the agent (tests). */
  removeAuth?: (home: string) => void;
}

export const CODEX_BUSY_MESSAGE = 'A Codex thread is working. Stop it or wait until it ends, then sign out.';

const defaultLogout = (env: Record<string, string>): Promise<void> => new Promise((resolve) => {
  execFile('codex', ['logout'], { env, timeout: 20_000 }, () => resolve());
});

const REMOVE_AUTH = `require('fs').rmSync(require('path').join(process.argv[1], 'auth.json'), { force: true });`;

export async function signOutCodexCli(d: CodexSignOutDeps): Promise<CodexSignOutResult> {
  const busy = d.busyThread();
  if (busy !== null) return { ok: false, status: 409, error: CODEX_BUSY_MESSAGE };
  d.stopThreads();
  const env = { ...d.env(), CODEX_HOME: d.home } as Record<string, string>;
  await (d.runLogout ?? defaultLogout)(env);
  const auth = path.join(d.home, 'auth.json');
  if (fs.existsSync(auth)) {
    try { (d.removeAuth ?? ((home: string) => agentNode(REMOVE_AUTH, [home])))(d.home); } catch { /* checked below */ }
  }
  if (fs.existsSync(auth)) return { ok: false, status: 500, error: 'Codex could not sign out. Try again.' };
  d.forgetUsage();
  return { ok: true, signedIn: false };
}
