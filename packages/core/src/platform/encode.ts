/**
 * Encodes a working directory into the Claude Code transcript folder name
 * (`~/.claude/projects/<encoded>`). The scheme mirrors Claude Code's own per
 * platform.
 */
export function encodeClaudeProjectDir(workDir: string, platform: 'darwin'): string {
  return workDir.replace(/\//g, '-');
}
