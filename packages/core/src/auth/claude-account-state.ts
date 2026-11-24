// packages/core/src/auth/claude-account-state.ts
// The first-run state of a NEW login folder on a local install (spec 2026-11-24, a full sign-in for a
// Claude account).
//
// Claude Code keeps "the first run is done" and "this project folder is trusted" in `.claude.json`,
// per config dir. A folder that `claude auth login` just made has neither. Seen on 2026-11-24 with
// Claude Code 2.1.331: the first interactive thread of such an account opened on the theme question,
// so a message that Dispatch types into the thread would go into that screen.
//
// So, once, right after the sign-in (no Claude Code process runs in the folder then), the folder takes
// over two things from the computer's own state: that the first run is done, and which project
// folders the person already trusts. It is the same person on the same computer. Nothing else is
// copied: not who is signed in, not a server, not a setting. A key that the account file already has
// is kept. These key names are Claude Code's own and not a public contract: when one changes, the
// result is the first-run screen again, never a broken login.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The computer's own Claude Code state file: in the home folder, or in CLAUDE_CONFIG_DIR when that is set. */
export function primaryClaudeStateFile(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? path.join(dir, '.claude.json') : path.join(home, '.claude.json');
}

type Json = Record<string, unknown>;
const readJson = (file: string): Json | null => {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Json : null;
  } catch { return null; }
};

/**
 * Give the account folder the computer's first-run state. True when the account file was written.
 * It never throws, and it never makes the account file: Claude Code makes it at the sign-in.
 */
export function seedAccountClaudeState(configDir: string, primaryFile: string = primaryClaudeStateFile()): boolean {
  const primary = readJson(primaryFile);
  if (!primary || primary.hasCompletedOnboarding !== true) return false;
  const file = path.join(configDir, '.claude.json');
  const own = readJson(file);
  if (!own) return false;
  const next: Json = { ...own };
  if (next.hasCompletedOnboarding === undefined) next.hasCompletedOnboarding = true;
  if (next.lastOnboardingVersion === undefined && typeof primary.lastOnboardingVersion === 'string') next.lastOnboardingVersion = primary.lastOnboardingVersion;
  const trusted = Object.entries((primary.projects ?? {}) as Record<string, Json | null>).filter(([, p]) => p?.hasTrustDialogAccepted === true).map(([dir]) => dir);
  if (trusted.length) {
    const projects: Record<string, Json> = { ...((own.projects ?? {}) as Record<string, Json>) };
    for (const dir of trusted) projects[dir] = { ...(projects[dir] ?? {}), hasTrustDialogAccepted: true };
    next.projects = projects;
  }
  try {
    const tmp = `${file}.dispatch-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}
