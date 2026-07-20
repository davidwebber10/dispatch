/**
 * Encodes a working directory into the Claude Code transcript folder name
 * (`~/.claude/projects/<encoded>`). The scheme mirrors Claude Code's own per
 * platform.
 *
 * Claude Code replaces EVERY non-alphanumeric character with a dash — not just the
 * separator. Verified against the whole local corpus: this rule resolved 37/37 project
 * directories, while replacing only `/` resolved 22/37, and replacing `/` and `.` resolved
 * 31/37 (that one still missed `_` in macOS temp paths and `+` in branch names).
 *
 * The `/`-only rule this used to implement is why a dot-directory was unfindable: a worktree
 * at `<repo>/.claude/worktrees/x` lives under `...-repo--claude-worktrees-x` — the slash and
 * the dot EACH become a dash — but we computed `...-repo-.claude-worktrees-x`, a directory
 * that never exists, so the thread's chat rendered empty.
 *
 * The encoding is lossy and therefore one-way: two distinct paths can collapse to the same
 * folder name, which is why nothing tries to invert it. See sessions/transcript-path.ts for
 * how a transcript is located when this computed directory turns out to be the wrong one.
 */
export function encodeClaudeProjectDir(workDir: string, platform: 'darwin'): string {
  return workDir.replace(/[^a-zA-Z0-9]/g, '-');
}
